process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const KadenceUtils = require('@kadenceproject/kadence/lib/utils.js');

const levelup = require('levelup');
const sqldown = require('sqldown');
const encoding = require('encoding-down');
const kadence = require('@kadenceproject/kadence');
const config = require('./Config');
const fs = require('fs');
const utilities = require('./Utilities');
const PeerCache = require('./kademlia/PeerCache');
const _ = require('lodash');
const sleep = require('sleep');

/**
 * DHT module (Kademlia)
 */
class Network {
    /**
     * Setup options and construct a node
     */
    constructor(ctx) {
        this.log = ctx.logger;
        this.emitter = ctx.emitter;
        this.networkUtilities = ctx.networkUtilities;

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
        this.networkUtilities.verifyConfiguration(config);

        this.log.info('Checking SSL certificate');
        await this.networkUtilities.setSelfSignedCertificate(config);

        this.log.info('Getting the identity');
        this.xprivkey = fs.readFileSync(`${__dirname}/../keys/${config.private_extended_key_path}`).toString();
        this.identity = new kadence.eclipse.EclipseIdentity(
            this.xprivkey,
            this.index,
            kadence.constants.HD_KEY_DERIVATION_PATH,
        );

        this.log.info('Checking the identity');
        // Check if identity is valid
        this.networkUtilities.checkIdentity(this.identity);

        const { childKey } = this.networkUtilities.getIdentityKeys(
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
    async start() {
        this.log.info('Initializing network');

        const { parentKey } = this.networkUtilities.getIdentityKeys(
            this.xprivkey,
            kadence.constants.HD_KEY_DERIVATION_PATH,
            parseInt(config.child_derivation_index, 10),
        );

        // Initialize public contact data
        const contact = {
            hostname: config.node_rpc_ip,
            protocol: 'https:',
            port: parseInt(config.node_port, 10),
            xpub: parentKey.publicExtendedKey,
            index: parseInt(config.child_derivation_index, 10),
            agent: kadence.version.protocol,
            wallet: config.node_wallet,
        };

        const key = fs.readFileSync(`${__dirname}/../keys/${config.ssl_keypath}`);
        const cert = fs.readFileSync(`${__dirname}/../keys/${config.ssl_certificate_path}`);
        const ca = config.ssl_authority_paths.map(fs.readFileSync);

        // Initialize transport adapter
        const transport = new kadence.HTTPSTransport({ key, cert, ca });

        // Initialize protocol implementation
        this.node = new kadence.KademliaNode({
            logger: this.log,
            transport,
            identity: Buffer.from(this.identity, 'hex'),
            contact,
            storage: levelup(encoding(sqldown(`${__dirname}/Database/system.db`)), {
                table: 'node_data',
            }, (err) => {
                if (err) {
                    this.log.error('Failed to create SQLite3 Kademlia adapter');
                    throw err;
                }
            }),
        });
        this.log.info('Starting OT Node...');
        this.node.quasar = this.node.plugin(kadence.quasar());
        this.log.info('Quasar initialised');
        // this.node.eclipse = this.node.plugin(kadence.eclipse());
        this.node.peercache = this.node.plugin(PeerCache(`${__dirname}/../data/${config.embedded_peercache_path}`));
        this.log.info('Peercache initialised');
        this.node.spartacus = this.node.plugin(kadence.spartacus(
            this.xprivkey,
            parseInt(config.child_derivation_index, 10),
            kadence.constants.HD_KEY_DERIVATION_PATH,
        ));
        this.log.info('Spartacus initialised');
        this.node.hashcash = this.node.plugin(kadence.hashcash({
            methods: ['PUBLISH', 'SUBSCRIBE'],
            difficulty: 8,
        }));
        this.log.info('Hashcash initialised');

        if (parseInt(config.onion_enabled, 10)) {
            this.enableOnion();
        }

        if (parseInt(config.traverse_nat_enabled, 10)) {
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
            this.networkUtilities.registerControlInterface(config, this.node);

            const connected = false;
            const retryPeriodSeconds = 5;
            while (!connected) {
                try {
                    // eslint-disable-next-line
                    const connected = await this._joinNetwork();
                    if (connected) {
                        break;
                    }
                } catch (e) {
                    this.log.error(`Failed to join network ${e}`);
                }
                this.log.error(`Failed to join network, will retry in ${retryPeriodSeconds} seconds. Bootstrap nodes are probably not online.`);
                sleep.sleep(5);
            }
        });
    }

    enableNatTraversal() {
        this.log.info('Trying NAT traversal');
        this.node.traverse = this.node.plugin(kadence.traverse([
            new kadence.traverse.UPNPStrategy({
                mappingTtl: parseInt(config.traverse_port_forward_ttl, 10),
                publicPort: parseInt(this.node.contact.port, 10),
            }),
            new kadence.traverse.NATPMPStrategy({
                mappingTtl: parseInt(config.traverse_port_forward_ttl, 10),
                publicPort: parseInt(this.node.contact.port, 10),
            }),
        ]));
    }

    enableOnion() {
        this.log.info('Use Tor for an anonymous overlay');
        kadence.constants.T_RESPONSETIMEOUT = 20000;
        this.node.onion = this.node.plugin(kadence.onion({
            dataDirectory: `${__dirname}/../data/hidden_service`,
            virtualPort: config.onion_virtual_port,
            localMapping: `127.0.0.1:${config.node_port}`,
            torrcEntries: {
                CircuitBuildTimeout: 10,
                KeepalivePeriod: 60,
                NewCircuitPeriod: 60,
                NumEntryGuards: 8,
                Log: 'notice stdout',
            },
            passthroughLoggingEnabled: 1,
        }));
        this.log.info('Onion initialised');
    }

    /**
     * Try to join network
     * Note: this method tries to find possible bootstrap nodes from cache as well
     */
    async _joinNetwork() {
        const bootstrapNodes = config.network_bootstrap_nodes;

        const peercachePlugin = this.node.peercache;
        const peers = await peercachePlugin.getBootstrapCandidates();

        const isBootstrap = bootstrapNodes.length === 0;
        let nodes = _.uniq(bootstrapNodes.concat(peers));

        if (isBootstrap) {
            this.log.info(`Found ${bootstrapNodes.length} provided bootstrap node(s). Running as a Bootstrap node`);
            this.log.info(`Found additional ${peers.length} peers in peer cache`);
            this.log.info(`Trying to contact ${nodes.length} peers from peer cache`);
        } else {
            this.log.info(`Found ${bootstrapNodes.length} provided bootstrap node(s)`);
            this.log.info(`Found additional ${peers.length} peers in peer cache`);
            this.log.info(`Trying to join the network from ${nodes.length} unique seeds`);
        }

        if (nodes.length === 0) {
            this.log.info('No bootstrap seeds provided and no known profiles');
            this.log.info('Running in seed mode (waiting for connections)');

            this.node.router.events.once('add', async (identity) => {
                config.NetworkBootstrapNodes = [
                    kadence.utils.getContactURL([
                        identity,
                        this.node.router.getContactByNodeId(identity),
                    ]),
                ];
                await this._joinNetwork();
            });
            return true;
        }
        nodes = nodes.slice(0, 10); // take no more than 10 peers for joining

        const func = url => new Promise((resolve, reject) => {
            try {
                this.log.info(`Joining via ${url}`);
                const contact = kadence.utils.parseContactURL(url);

                this.node.join(contact, (err, x) => {
                    if (err) {
                        // eslint-disable-next-line
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
            this.log.important('Joined the network');
            const contact = kadence.utils.parseContactURL(result);

            this.log.info(`Connected to network via ${contact[0]} (https://${contact[1].hostname}:${contact[1].port})`);
            this.log.info(`Discovered ${this.node.router.size} peers from seed`);
            return true;
        } else if (isBootstrap) {
            this.log.info('Bootstrap node couldn\'t contact peers from peer cache. Waiting for some peers.');
            return true;
        }
        return false;
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
            this.log.info('kad-payload-request received');
            this.emitter.emit('kad-payload-request', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-replication-request', (request, response, next) => {
            this.log.info('kad-replication-request received');
            this.emitter.emit('kad-replication-request', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-replication-finished', (request, response, next) => {
            this.log.info('kad-replication-finished received');
            this.emitter.emit('kad-replication-finished', request);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-data-location-response', (request, response, next) => {
            this.log.info('kad-data-location-response received');
            this.emitter.emit('kad-data-location-response', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-data-read-request', (request, response, next) => {
            this.log.info('kad-data-read-request received');
            this.emitter.emit('kad-data-read-request', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-data-read-response', (request, response, next) => {
            this.log.info('kad-data-read-response received');
            this.emitter.emit('kad-data-read-response', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-send-encrypted-key', (request, response, next) => {
            this.log.info('kad-send-encrypted-key received');
            this.emitter.emit('kad-send-encrypted-key', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-encrypted-key-process-result', (request, response, next) => {
            this.log.info('kad-encrypted-key-process-result received');
            this.emitter.emit('kad-encrypted-key-process-result', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-verify-import-request', (request, response, next) => {
            this.log.info('kad-verify-import-request received');
            this.emitter.emit('kad-verify-import-request', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // async
        this.node.use('kad-verify-import-response', (request, response, next) => {
            this.log.info('kad-verify-import-response received');
            this.emitter.emit('kad-verify-import-response', request, response);
            response.send({
                status: 'RECEIVED',
            });
        });

        // sync
        this.node.use('kad-challenge-request', (request, response, next) => {
            this.log.info('kad-challenge-request received');
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
             * @param contactId Contact ID
             * @returns {{"{": Object}|Array}
             */
            node.getContact = async (contactId) => {
                let contact = node.router.getContactByNodeId(contactId);
                if (contact == null || contact.hostname == null) {
                    // check peercache
                    contact = await this.node.peercache.getExternalPeerInfo(contactId);
                    if (contact) {
                        const contactInfo = KadenceUtils.parseContactURL(contact);
                        // refresh bucket
                        if (contactInfo) {
                            // eslint-disable-next-line
                            contact = contactInfo[1];
                            this.node.router.addContactByNodeId(contactId, contact);
                        } else {
                            // ask network
                            contact = await node.find(contactId);
                            if (contact) {
                                this.node.router.addContactByNodeId(contactId, contact);
                            }
                        }
                    }
                }
                return contact;
            };

            node.find = async contactId => new Promise((resolve, reject) => {
                this.node.iterativeFindNode(contactId.toString('hex'), (err, res) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    for (const contact of res) {
                        if (contact[0] === contactId) {
                            resolve(contact[1]);
                            return;
                        }
                    }
                    return resolve(null);
                });
            });

            node.payloadRequest = async (message, contactId, callback) => {
                const contact = await node.getContact(contactId);
                node.send('kad-payload-request', { message }, [contactId, contact], callback);
            };

            node.replicationRequest = async (message, contactId, callback) => {
                // contactId = utilities.numberToHex(contactId).substring(2);
                const contact = await node.getContact(contactId);
                node.send('kad-replication-request', { message }, [contactId, contact], callback);
            };

            node.replicationFinished = async (message, contactId, callback) => {
                const contact = await node.getContact(contactId);
                node.send('kad-replication-finished', { message }, [contactId, contact], callback);
            };

            node.challengeRequest = async (message, contactId, callback) => {
                const contact = await node.getContact(contactId);
                node.send('kad-challenge-request', { message }, [contactId, contact], callback);
            };

            node.sendDataLocationResponse = async (message, contactId, callback) => {
                const contact = await node.getContact(contactId);
                node.send('kad-data-location-response', { message }, [contactId, contact], callback);
            };

            node.dataReadRequest = async (message, contactId, callback) => {
                const contact = await node.getContact(contactId);
                node.send('kad-data-read-request', { message }, [contactId, contact], callback);
            };

            node.sendDataReadResponse = async (message, contactId, callback) => {
                const contact = await node.getContact(contactId);
                node.send('kad-data-read-response', { message }, [contactId, contact], callback);
            };

            node.sendEncryptedKey = async (message, contactId, callback) => {
                const contact = await node.getContact(contactId);
                node.send('kad-send-encrypted-key', { message }, [contactId, contact], callback);
            };

            node.sendEncryptedKeyProcessResult = async (message, contactId, callback) => {
                const contact = await node.getContact(contactId);
                node.send('kad-encrypted-key-process-result', { message }, [contactId, contact], callback);
            };

            node.verifyImport = async (message, contactId, callback) => {
                const contact = await node.getContact(contactId);
                node.send('kad-verify-import-request', { message }, [contactId, contact], callback);
            };

            node.sendVerifyImportResponse = async (message, contactId, callback) => {
                const contact = await node.getContact(contactId);
                node.send('kad-verify-import-response', { message }, [contactId, contact], callback);
            };
        });
        // Define a global custom error handler rule
        this.node.use((err, request, response, next) => {
            this.log.warn(`KADemlia error. ${err}. Request: ${request}.`);
            response.send({ error: err.message });
        });
    }

    kademlia() {
        return this.node;
    }
}

module.exports = Network;
