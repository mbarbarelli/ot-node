process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const async = require('async');
const levelup = require('levelup');
const encoding = require('encoding-down');
const kadence = require('@kadenceproject/kadence');
const config = require('../../Config');
const fs = require('fs');
const utilities = require('../../Utilities');
const _ = require('lodash');
const sleep = require('sleep-async')().Promise;
const leveldown = require('leveldown');
const PeerCache = require('./peer-cache');
const ip = require('ip');

const pjson = require('../../../package.json');

const { NetworkRequestIgnoredError } = require('../../errors/index');

/**
 * DHT module (Kademlia)
 */
class Kademlia {
    /**
     * Setup options and construct a node
     */
    constructor(ctx) {
        this.log = ctx.logger;
        this.emitter = ctx.emitter;
        this.kademliaUtilities = ctx.kademliaUtilities;
        this.notifyError = ctx.notifyError;

        kadence.constants.T_RESPONSETIMEOUT = parseInt(config.request_timeout, 10);
        if (parseInt(config.test_network, 10)) {
            this.log.warn('Node is running in test mode, difficulties are reduced');
            process.env.kadence_TestNetworkEnabled = config.test_network;
            kadence.constants.SOLUTION_DIFFICULTY = kadence.constants.TESTNET_DIFFICULTY;
            kadence.constants.IDENTITY_DIFFICULTY = kadence.constants.TESTNET_DIFFICULTY;
        }
        this.index = parseInt(config.child_derivation_index, 10);

        // Initialize private extended key
        utilities.createPrivateExtendedKey(kadence);
    }

    /**
     * Initializes keys
     * @return {Promise<void>}
     */
    async initialize() {
        // Check config
        this.kademliaUtilities.verifyConfiguration(config);

        this.log.info('Checking SSL certificate');
        await this.kademliaUtilities.setSelfSignedCertificate(config);

        this.log.info('Getting the identity');
        this.xprivkey = fs.readFileSync(`${__dirname}/../../../keys/${config.private_extended_key_path}`).toString();
        this.identity = new kadence.eclipse.EclipseIdentity(
            this.xprivkey,
            this.index,
            kadence.constants.HD_KEY_DERIVATION_PATH,
        );

        this.log.info('Checking the identity');
        // Check if identity is valid
        this.kademliaUtilities.checkIdentity(this.identity);

        const { childKey } = this.kademliaUtilities.getIdentityKeys(
            this.xprivkey,
            kadence.constants.HD_KEY_DERIVATION_PATH,
            parseInt(config.child_derivation_index, 10),
        );
        this.identity = kadence.utils.toPublicKeyHash(childKey.publicKey).toString('hex');

        this.log.notify(`My identity: ${this.identity}`);
        config.identity = this.identity;
    }

    /**
     * Starts the node
     * @return {Promise<void>}
     */
    start() {
        return new Promise(async (resolve) => {
            this.log.info('Initializing network');

            const { parentKey } = this.kademliaUtilities.getIdentityKeys(
                this.xprivkey,
                kadence.constants.HD_KEY_DERIVATION_PATH,
                parseInt(config.child_derivation_index, 10),
            );

            const onionEnabled = parseInt(config.onion_enabled, 10);
            const natTraversalEnabled = parseInt(config.traverse_nat_enabled, 10);

            let kadServerHost = null;
            if (config.local_network_only || natTraversalEnabled || onionEnabled) {
                kadServerHost = '127.0.0.1';
            } else {
                kadServerHost = await utilities.getExternalIp();
            }

            // Initialize public contact data
            const contact = {
                hostname: kadServerHost,
                protocol: 'https:',
                port: parseInt(config.node_port, 10),
                xpub: parentKey.publicExtendedKey,
                index: parseInt(config.child_derivation_index, 10),
                agent: kadence.version.protocol,
                wallet: config.node_wallet,
                network_id: config.network_id,
            };

            const key = fs.readFileSync(`${__dirname}/../../../keys/${config.ssl_keypath}`);
            const cert = fs.readFileSync(`${__dirname}/../../../keys/${config.ssl_certificate_path}`);
            const ca = config.ssl_authority_paths.map(fs.readFileSync);

            // Initialize transport adapter
            const transport = new kadence.HTTPSTransport({ key, cert, ca });

            // Initialize protocol implementation
            this.node = new kadence.KademliaNode({
                logger: this.log,
                transport,
                identity: Buffer.from(this.identity, 'hex'),
                contact,
                storage: levelup(encoding(leveldown(`${__dirname}/../../../data/kadence.dht`))),
            });

            const { validateContact } = this;

            // Override node's _updateContact method to filter contacts.
            this.node._updateContact = (identity, contact) => {
                try {
                    if (!validateContact(contact)) {
                        this.log.debug(`Ignored contact ${identity}. Hostname ${contact.hostname}. Network ID ${contact.network_id}.`);
                        return;
                    }
                } catch (err) {
                    this.log.debug(`Failed to filter contact(${identity}, ${contact}). ${err}.`);
                    return;
                }

                // Simulate node's "super._updateContact(identity, contact)".
                this.node.constructor.prototype.constructor.prototype
                    ._updateContact.call(this.node, identity, contact);
            };

            this.node.use((request, response, next) => {
                if (!validateContact(request.contact[1])) {
                    return next(new NetworkRequestIgnoredError('Contact not valid.', request));
                }
                next();
            });

            this.log.info('Starting OT Node...');
            this.node.eclipse = this.node.plugin(kadence.eclipse());
            this.node.quasar = this.node.plugin(kadence.quasar());
            this.log.info('Quasar initialised');
            this.node.peercache = this.node.plugin(PeerCache(`${__dirname}/../../../data/${config.embedded_peercache_path}`));
            this.log.info('Peercache initialised');
            this.node.spartacus = this.node.plugin(kadence.spartacus(
                this.xprivkey,
                parseInt(config.child_derivation_index, 10),
                kadence.constants.HD_KEY_DERIVATION_PATH,
            ));
            this.log.info('Spartacus initialized');

            if (onionEnabled) {
                this.enableOnion();
            }

            if (natTraversalEnabled) {
                this.enableNatTraversal();
            }

            // Use verbose logging if enabled
            if (parseInt(config.verbose_logging, 10)) {
                this.node.rpc.deserializer.append(new kadence.logger.IncomingMessage(this.log));
                this.node.rpc.serializer.prepend(new kadence.logger.OutgoingMessage(this.log));
            }
            // Cast network nodes to an array
            if (typeof config.network_bootstrap_nodes === 'string') {
                config.network_bootstrap_nodes = config.network_bootstrap_nodes.trim().split();
            }

            if (!utilities.isBootstrapNode()) {
                this._registerRoutes();
            }

            this.node.listen(parseInt(config.node_port, 10), async () => {
                this.log.notify(`OT Node listening at https://${this.node.contact.hostname}:${this.node.contact.port}`);
                this.kademliaUtilities.registerControlInterface(config, this.node);

                const connected = false;
                const retryPeriodSeconds = 5;
                while (!connected) {
                    try {
                        // eslint-disable-next-line
                        const connected = await this._joinNetwork(contact);
                        if (connected) {
                            resolve();
                            break;
                        }
                    } catch (e) {
                        this.log.error(`Failed to join network ${e}`);
                        this.notifyError(e);
                    }

                    this.log.error(`Failed to join network, will retry in ${retryPeriodSeconds} seconds. Bootstrap nodes are probably not online.`);
                    // eslint-disable-next-line
                    await sleep.sleep(retryPeriodSeconds * 1000);
                }
            });
        });
    }

    enableNatTraversal() {
        this.log.info('Trying NAT traversal');

        const remoteAddress = config.reverse_tunnel_address;
        const remotePort = parseInt(config.reverse_tunnel_port, 10);

        this.node.traverse = this.node.plugin(kadence.traverse([
            new kadence.traverse.ReverseTunnelStrategy({
                remotePort,
                remoteAddress,
                privateKey: this.node.spartacus.privateKey,
                secureLocalConnection: true,
                verboseLogging: false,
            }),
        ]));
    }

    /**
     * Enables Onion client
     */
    enableOnion() {
        this.log.info('Use Tor for an anonymous overlay');
        this.node.onion = this.node.plugin(kadence.onion({
            dataDirectory: `${__dirname}/../../../data/hidden_service`,
            virtualPort: config.onion_virtual_port,
            localMapping: `127.0.0.1:${config.node_port}`,
            torrcEntries: {
                LearnCircuitBuildTimeout: 0,
                CircuitBuildTimeout: 40,
                CircuitStreamTimeout: 30,
                MaxCircuitDirtiness: 7200,
                MaxClientCircuitsPending: 1024,
                SocksTimeout: 41,
                CloseHSClientCircuitsImmediatelyOnTimeout: 1,
                CloseHSServiceRendCircuitsImmediatelyOnTimeout: 1,
                SafeLogging: 0,
                FetchDirInfoEarly: 1,
                FetchDirInfoExtraEarly: 1,
            },
            passthroughLoggingEnabled: 1,
        }));
        this.log.info('Onion initialised');
    }

    /**
     * Try to join network
     * Note: this method tries to find possible bootstrap nodes from cache as well
     */
    async _joinNetwork(myContact) {
        const bootstrapNodes = config.network_bootstrap_nodes;
        utilities.shuffle(bootstrapNodes);

        const peercachePlugin = this.node.peercache;
        const peers = await peercachePlugin.getBootstrapCandidates();
        let nodes = _.uniq(bootstrapNodes.concat(peers));
        nodes = nodes.slice(0, 5); // take no more than 5 peers for joining

        if (utilities.isBootstrapNode()) {
            this.log.info(`Found ${bootstrapNodes.length} provided bootstrap node(s). Running as a Bootstrap node`);
            this.log.info(`Found additional ${peers.length} peers in peer cache`);
        } else {
            this.log.info(`Found ${bootstrapNodes.length} provided bootstrap node(s)`);
            this.log.info(`Found additional ${peers.length} peers in peer cache`);
        }

        this.log.info(`Sync with network from ${nodes.length} unique peers`);
        if (nodes.length === 0) {
            this.log.info('No bootstrap seeds provided and no known profiles');
            this.log.info('Running in seed mode (waiting for connections)');

            this.node.router.events.once('add', async (identity) => {
                config.network_bootstrap_nodes = [
                    kadence.utils.getContactURL([
                        identity,
                        this.node.router.getContactByNodeId(identity),
                    ]),
                ];
                await this._joinNetwork(myContact);
            });
            return true;
        }

        const func = url => new Promise((resolve, reject) => {
            try {
                this.log.info(`Syncing with peers via ${url}.`);
                const contact = kadence.utils.parseContactURL(url);

                this._join(contact, (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    if (this.node.router.size >= 1) {
                        resolve(url);
                    } else {
                        resolve(null);
                    }
                });
            } catch (err) {
                reject(err);
            }
        });

        let result;
        for (const node of nodes) {
            try {
                // eslint-disable-next-line
                result = await func(node);
                if (result) {
                    break;
                }
            } catch (e) {
                this.log.warn(`Failed to join via ${node}`);
            }
        }

        if (result) {
            this.log.important('Initial sync with other peers done');

            setTimeout(() => {
                this.node.refresh(this.node.router.getClosestBucket() + 1);
            }, 5000);
            return true;
        } else if (utilities.isBootstrapNode()) {
            this.log.info('Bootstrap node couldn\'t contact peers. Waiting for some peers.');
            return true;
        }
        return false;
    }

    _join([identity, contact], callback) {
        /* istanbul ignore else */
        if (callback) {
            this.node.once('join', callback);
            this.node.once('error', callback);
        }

        this.node.router.addContactByNodeId(identity, contact);
        async.series([
            next => this.node.iterativeFindNode(this.identity.toString('hex'), next),
        ], (err) => {
            if (err) {
                this.node.emit('error', err);
            } else {
                this.node.emit('join');
            }

            if (callback) {
                this.node.removeListener('join', callback);
                this.node.removeListener('error', callback);
            }
        });
    }

    /**
     * Register Kademlia routes and error handlers
     */
    _registerRoutes() {
        this.node.quasar.quasarSubscribe('kad-data-location-request', (message, err) => {
            this.log.info('New location request received');
            this.emitter.emit('kad-data-location-request', message);
        });

        // async
        this.node.use('kad-payload-request', (request, response, next) => {
            this.log.debug('kad-payload-request received');
            this.emitter.emit('kad-payload-request', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-replication-request', (request, response, next) => {
            this.log.debug('kad-replication-request received');
            this.emitter.emit('kad-replication-request', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-replication-finished', (request, response, next) => {
            this.log.debug('kad-replication-finished received');
            this.emitter.emit('kad-replication-finished', request);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-data-location-response', (request, response, next) => {
            this.log.debug('kad-data-location-response received');
            this.emitter.emit('kad-data-location-response', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-data-read-request', (request, response, next) => {
            this.log.debug('kad-data-read-request received');
            this.emitter.emit('kad-data-read-request', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-data-read-response', (request, response, next) => {
            this.log.debug('kad-data-read-response received');
            this.emitter.emit('kad-data-read-response', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-send-encrypted-key', (request, response, next) => {
            this.log.debug('kad-send-encrypted-key received');
            this.emitter.emit('kad-send-encrypted-key', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-encrypted-key-process-result', (request, response, next) => {
            this.log.debug('kad-encrypted-key-process-result received');
            this.emitter.emit('kad-encrypted-key-process-result', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-verify-import-request', (request, response, next) => {
            this.log.debug('kad-verify-import-request received');
            this.emitter.emit('kad-verify-import-request', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-verify-import-response', (request, response, next) => {
            this.log.debug('kad-verify-import-response received');
            this.emitter.emit('kad-verify-import-response', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // sync
        this.node.use('kad-challenge-request', (request, response, next) => {
            this.log.debug('kad-challenge-request received');
            this.emitter.emit('kad-challenge-request', request, response);
        });

        // error handler
        this.node.use('kad-challenge-request', (err, request, response, next) => {
            response.send({
                error: 'kad-challenge-request error',
            });
        });

        // error handler
        this.node.use('kad-payload-request', (err, request, response, next) => {
            response.send({
                error: 'kad-payload-request error',
            });
        });

        // error handler
        this.node.use('kad-replication-finished', (err, request, response, next) => {
            response.send({
                error: 'kad-replication-finished error',
            });
        });

        // Define a global custom error handler rule
        this.node.use((err, request, response, next) => {
            if (err instanceof NetworkRequestIgnoredError.constructor) {
                this.log.debug(`Network request ignored. Contact ${JSON.stringify(request.contact)}`);
                response.send([]);
                return;
            }

            this.log.warn(`KADemlia error. ${err}. Request: ${request}.`);
            response.send({ error: err.message });
        });

        // creates Kadence plugin for RPC calls
        this.node.plugin((node) => {
            /**
             * Helper method for getting nearest contact (used for testing purposes only)
             * @returns {*}
             */
            node.getNearestNeighbour = () =>
                [...node.router.getClosestContactsToKey(this.identity).entries()].shift();

            /**
             * Gets contact by ID
             * @param retry Should retry to find it?
             * @param contactId Contact ID
             * @returns {{"{": Object}|Array}
             */
            node.getContact = async (contactId, retry) => {
                const contact = node.router.getContactByNodeId(contactId);
                if (contact && contact.hostname) {
                    return contact;
                }
                // try to find out about the contact from peers
                await node.refreshContact(contactId, retry);
                return this.node.router.getContactByNodeId(contactId);
            };

            /**
             * Tries to refresh buckets based on contact ID
             * @param contactId
             * @param retry
             * @return {Promise}
             */
            node.refreshContact = async (contactId, retry) => new Promise(async (resolve) => {
                const _refresh = () => new Promise((resolve, reject) => {
                    this.node.iterativeFindNode(contactId, (err, res) => {
                        if (err) {
                            reject(err);
                        } else {
                            const contact = this.node.router.getContactByNodeId(contactId);
                            if (contact && contact.hostname) {
                                resolve(contact);
                            } else {
                                resolve(null);
                            }
                        }
                    });
                });

                try {
                    if (retry) {
                        for (let i = 1; i <= 3; i += 1) {
                            // eslint-disable-next-line no-await-in-loop
                            const contact = await _refresh();
                            if (contact) {
                                resolve(contact);
                                return;
                            }
                            // eslint-disable-next-line
                            await sleep.sleep((2 ** i) * 1000);
                        }
                    } else {
                        await _refresh(contactId, retry);
                    }

                    resolve(null);
                } catch (e) {
                    // failed to refresh buckets (should not happen)
                    this.notifyError(e);
                }
            });

            node.payloadRequest = async (message, contactId) => {
                const contact = await node.getContact(contactId);
                return new Promise((resolve, reject) => {
                    node.send('kad-payload-request', { message }, [contactId, contact], (err, res) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(res);
                        }
                    });
                });
            };

            node.replicationRequest = async (message, contactId) => {
                const contact = await node.getContact(contactId);
                return new Promise((resolve, reject) => {
                    node.send('kad-replication-request', { message }, [contactId, contact], (err, res) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(res);
                        }
                    });
                });
            };

            node.replicationFinished = async (message, contactId) => {
                const contact = await node.getContact(contactId);
                return new Promise((resolve, reject) => {
                    node.send('kad-replication-finished', { message }, [contactId, contact], (err, res) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(res);
                        }
                    });
                });
            };

            node.challengeRequest = async (message, contactId) => {
                const contact = await node.getContact(contactId);
                return new Promise((resolve, reject) => {
                    node.send('kad-challenge-request', { message }, [contactId, contact], (err, res) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(res);
                        }
                    });
                });
            };

            node.sendDataLocationResponse = async (message, contactId) => {
                const contact = await node.getContact(contactId);
                return new Promise((resolve, reject) => {
                    node.send('kad-data-location-response', { message }, [contactId, contact], (err, res) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(res);
                        }
                    });
                });
            };

            node.dataReadRequest = async (message, contactId) => {
                const contact = await node.getContact(contactId);
                return new Promise((resolve, reject) => {
                    node.send('kad-data-read-request', { message }, [contactId, contact], (err, res) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(res);
                        }
                    });
                });
            };

            node.sendDataReadResponse = async (message, contactId) => {
                const contact = await node.getContact(contactId);
                return new Promise((resolve, reject) => {
                    node.send('kad-data-read-response', { message }, [contactId, contact], (err, res) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(res);
                        }
                    });
                });
            };

            node.sendEncryptedKey = async (message, contactId) => {
                const contact = await node.getContact(contactId);
                return new Promise((resolve, reject) => {
                    node.send('kad-send-encrypted-key', { message }, [contactId, contact], (err, res) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(res);
                        }
                    });
                });
            };

            node.sendEncryptedKeyProcessResult = async (message, contactId) => {
                const contact = await node.getContact(contactId);
                return new Promise((resolve, reject) => {
                    node.send('kad-encrypted-key-process-result', { message }, [contactId, contact], (err, res) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(res);
                        }
                    });
                });
            };

            node.verifyImport = async (message, contactId) => {
                const contact = await node.getContact(contactId);
                return new Promise((resolve, reject) => {
                    node.send('kad-verify-import-request', { message }, [contactId, contact], (err, res) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(res);
                        }
                    });
                });
            };

            node.sendVerifyImportResponse = async (message, contactId) => {
                const contact = await node.getContact(contactId);
                return new Promise((resolve, reject) => {
                    node.send('kad-verify-import-response', { message }, [contactId, contact], (err, res) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(res);
                        }
                    });
                });
            };

            node.publish = async (topic, message, opts = {}) => new Promise((resolve, reject) => {
                node.quasar.quasarPublish(
                    topic, message, opts,
                    (err, res) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(res);
                        }
                    },
                );
            });
        });
    }

    /**
     * Sends response
     * @param response
     * @param data
     * @returns {Promise<void>}
     */
    sendResponse(response, data) {
        return new Promise((resolve, reject) => {
            response.send(data, (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Extracts message from native request
     * @param request
     * @returns {*}
     */
    extractMessage(request) {
        return request.params.message;
    }

    /**
     * Extracts status from native request
     * @param request
     * @returns {*}
     */
    extractStatus(request) {
        return request.params.status;
    }

    /**
     * Extracts sender identity from native request
     * @param request
     * @returns {*}
     */
    extractSenderID(request) {
        return request.contact[0];
    }

    /**
     * Extracts sender information from native request
     * @param request
     * @returns {*}
     */
    extractSenderInfo(request) {
        return request.contact[1];
    }

    /**
     * Validates contact.
     *
     * Checks if contact is in the network by checking network ID and if contact has IP
     * check if it's in the local or remote network based on current configuration.
     * @param contact Contact to check
     * @returns {boolean} true if contact is in the same network.
     */
    validateContact(contact) {
        if (ip.isV4Format(contact.hostname) || ip.isV6Format(contact.hostname)) {
            if (config.local_network_only && ip.isPublic(contact.hostname)) {
                return false;
            } else if (!config.local_network_only && ip.isPrivate(contact.hostname)) {
                return false;
            }
        }
        if (!contact.network_id || contact.network_id !== config.network_id) {
            return false;
        }

        return true;
    }

    /**
     * Returns basic network information
     */
    async getNetworkInfo() {
        const peers = [];
        const dump = this.node.router.getClosestContactsToKey(
            this.node.identity,
            kadence.constants.K * kadence.constants.B,
        );

        for (const peer of dump) {
            peers.push(peer);
        }

        return {
            versions: pjson.version,
            identity: this.node.identity.toString('hex'),
            contact: this.node.contact,
            peers,
        };
    }

    /**
     * Dumps all peers from buckets
     */
    dumpContacts() {
        const message = {};
        this.node.router.forEach((value, key, map) => {
            if (value.length > 0) {
                value.forEach((bValue, bKey, bMap) => {
                    message[bKey] = bValue;
                });
            }
        });
        return message;
    }
}

module.exports = Kademlia;
