const modulename = 'AdminVault';
import fse from 'fs-extra';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { cloneDeep } from 'lodash-es';
import { nanoid } from 'nanoid';
import { convars, txEnv } from '@core/globalData';
import CitizenFXProvider from './providers/CitizenFX.js';
import { createHash } from 'node:crypto';
import consoleFactory from '@extras/console';
const console = consoleFactory(modulename);


//Helpers
const migrateProviderIdentifiers = (providerName, providerData) => {
    if (providerName === 'citizenfx') {
        // data may be empty, or nameid may be invalid
        try {
            const res = /\/user\/(\d{1,8})/.exec(providerData.data.nameid);
            providerData.identifier = `fivem:${res[1]}`;
        } catch (error) {
            providerData.identifier = 'fivem:00000000';
        }
    } else if (providerName === 'discord') {
        providerData.identifier = `discord:${providerData.id}`;
    }
};


export default class AdminVault {
    constructor() {
        this.adminsFile = `${txEnv.dataPath}/admins.json`;
        this.adminsFileHash = null;
        this.admins = null;
        this.refreshRoutine = null;
        this.lastAdminFile = '';

        //Not alphabetical order, but that's fine
        this.registeredPermissions = {
            'all_permissions': 'All Permissions',
            'manage.admins': 'Manage Admins', //will enable the "set admin" button in the player modal
            'settings.view': 'Settings: View (no tokens)',
            'settings.write': 'Settings: Change',
            'console.view': 'Console: View',
            'console.write': 'Console: Write',
            'control.server': 'Start/Stop Server + Scheduler',
            'commands.resources': 'Start/Stop Resources',
            'server.cfg.editor': 'Read/Write server.cfg',
            'txadmin.log.view': 'View txAdmin Log',

            'menu.vehicle': 'Spawn / Fix Vehicles',
            'menu.clear_area': 'Reset world area',
            'menu.viewids': 'View Player IDs in-game', //be able to see the ID of the players
            'players.message': 'Announcement / DM', //enable/disable the dm button on modal as well
            'players.whitelist': 'Whitelist',
            'players.warn': 'Warn',
            'players.kick': 'Kick',
            'players.ban': 'Ban',
            'players.freeze': 'Freeze Players',
            'players.heal': 'Heal', //self, everyone, and the "heal" button in player modal
            'players.playermode': 'NoClip / God Mode', //self playermode, and also the player spectate option
            'players.spectate': 'Spectate', //self playermode, and also the player spectate option
            'players.teleport': 'Teleport', //self teleport, and the bring/go to on player modal
            'players.troll': 'Troll Actions', //all the troll options in the player modal
        };
        this.hardConfigs = {
            refreshInterval: 15e3,
        };


        //Load providers
        try {
            this.providers = {
                discord: false,
                citizenfx: new CitizenFXProvider(null),
            };
        } catch (error) {
            throw new Error(`Failed to load providers with error: ${error.message}`);
        }

        //Check if admins file exists
        let adminFileExists;
        try {
            fs.statSync(this.adminsFile, fs.constants.F_OK);
            adminFileExists = true;
        } catch (error) {
            if (error.code === 'ENOENT') {
                adminFileExists = false;
            } else {
                throw new Error(`Failed to check presence of admin file with error: ${error.message}`);
            }
        }

        //Printing PIN or starting loop
        if (!adminFileExists) {
            if (!convars.defaultMasterAccount) {
                this.addMasterPin = (Math.random() * 10000).toFixed().padStart(4, '0');
                this.admins = false;
            } else {
                console.log(`Setting up master account '${convars.defaultMasterAccount.name}'. The password is the same as in zap-hosting.com.`);
                this.createAdminsFile(convars.defaultMasterAccount.name, false, false, convars.defaultMasterAccount.password_hash, false);
            }
        } else {
            this.loadAdminsFile();
            this.setupRefreshRoutine();
        }
    }


    /**
     * sets the admins file refresh routine
     */
    setupRefreshRoutine() {
        this.refreshRoutine = setInterval(() => {
            this.checkAdminsFile();
        }, this.hardConfigs.refreshInterval);
    }


    /**
     * Creates a admins.json file based on the first account
     * @param {string} username
     * @param {string} identifier
     * @param {object} provider_data
     * @param {string} password backup password
     * @param {boolean} isPlainText
     * @returns {(boolean)} true or throws an error
     */
    createAdminsFile(username, identifier, provider_data, password, isPlainText) {
        //Sanity check
        if (this.admins !== false && this.admins !== null) throw new Error('Admins file already exists.');
        if (typeof username !== 'string' || username.length < 3) throw new Error('Invalid username parameter.');
        if (typeof password !== 'string' || password.length < 6) throw new Error('Invalid password parameter.');

        //Creating admin array
        let providers = {};
        if (identifier && provider_data) {
            providers.citizenfx = {
                id: username,
                identifier,
                data: provider_data,
            };
        }
        this.admins = [{
            name: username,
            master: true,
            password_hash: (isPlainText) ? GetPasswordHash(password) : password,
            providers,
            permissions: [],
        }];

        //Saving admin file
        try {
            const jsonData = JSON.stringify(this.admins);
            this.adminsFileHash = createHash('sha1').update(jsonData).digest('hex');
            fse.writeFileSync(this.adminsFile, jsonData, { encoding: 'utf8', flag: 'wx' });
            this.setupRefreshRoutine();
            return true;
        } catch (error) {
            let message = `Failed to create '${this.adminsFile}' with error: ${error.message}`;
            console.verbose.error(message);
            throw new Error(message);
        }
    }


    /**
     * Returns a list of admins and permissions
     */
    getAdminsList() {
        if (this.admins == false) return [];
        return this.admins.map((user) => {
            return {
                name: user.name,
                master: user.master,
                providers: Object.keys(user.providers),
                permissions: user.permissions,
            };
        });
    }


    /**
     * Returns the raw array of admins, except for the hash
     */
    getRawAdminsList() {
        if (this.admins === false) return [];
        return cloneDeep(this.admins);
    }


    /**
     * Returns all data from an admin by provider user id (ex discord id), or false
     * @param {string} uid
     */
    getAdminByProviderUID(uid) {
        if (this.admins == false) return false;
        let id = uid.trim().toLowerCase();
        if (!id.length) return false;
        let admin = this.admins.find((user) => {
            return Object.keys(user.providers).find((provider) => {
                return (id === user.providers[provider].id.toLowerCase());
            });
        });
        return (admin) ? cloneDeep(admin) : false;
    }


    /**
     * Returns all data from an admin by their name, or false
     * @param {string} uname
     */
    getAdminByName(uname) {
        if (!this.admins) return false;
        const username = uname.trim().toLowerCase();
        if (!username.length) return false;
        const admin = this.admins.find((user) => {
            return (username === user.name.toLowerCase());
        });
        return (admin) ? cloneDeep(admin) : false;
    }


    /**
     * Returns all data from an admin by game identifier, or false
     * @param {string[]} identifiers
     */
    getAdminByIdentifiers(identifiers) {
        if (!this.admins) return false;
        identifiers = identifiers
            .map((i) => i.trim().toLowerCase())
            .filter((i) => i.length);
        if (!identifiers.length) return false;
        const admin = this.admins.find((user) =>
            identifiers.find((identifier) =>
                Object.keys(user.providers).find((provider) =>
                    (identifier === user.providers[provider].identifier.toLowerCase()))));
        return (admin) ? cloneDeep(admin) : false;
    }


    /**
     * Returns a list with all registered permissions
     */
    getPermissionsList() {
        return cloneDeep(this.registeredPermissions);
    }


    /**
     * Writes to storage the admins file
     */
    async writeAdminsFile() {
        const jsonData = JSON.stringify(this.admins, null, 2);
        this.adminsFileHash = createHash('sha1').update(jsonData).digest('hex');
        await fsp.writeFile(this.adminsFile, jsonData, 'utf8');
        return true;
    }


    /**
     * Writes to storage the admins file
     */
    async checkAdminsFile() {
        const restore = async () => {
            try {
                await this.writeAdminsFile();
                console.ok('Restored admins.json file.');
            } catch (error) {
                console.error(`Failed to restore admins.json file: ${error.message}`);
                console.verbose.dir(error);
            }
        };
        try {
            const jsonData = await fse.readFile(this.adminsFile, 'utf8');
            const inboundHash = createHash('sha1').update(jsonData).digest('hex');
            if (this.adminsFileHash !== inboundHash) {
                console.warn('The admins.json file was modified or deleted by an external source, txAdmin will try to restore it.');
                restore();
            }
        } catch (error) {
            console.error(`Cannot check admins file integrity: ${error.message}`);
            restore();
        }
    }


    /**
     * Add a new admin to the admins file
     * NOTE: I'm fully aware this coud be optimized. Leaving this way to improve readability and error verbosity
     * @param {string} name
     * @param {object} citizenfxData or false
     * @param {object} discordData or false
     * @param {string} password
     * @param {array} permissions
     */
    async addAdmin(name, citizenfxData, discordData, password, permissions) {
        if (this.admins == false) throw new Error('Admins not set');

        //Check if username is already taken
        if (this.getAdminByName(name)) throw new Error('Username already taken');

        //Preparing admin
        const admin = {
            name: name,
            master: false,
            password_hash: GetPasswordHash(password),
            password_temporary: true,
            providers: {},
            permissions: permissions,
        };

        //Check if provider uid already taken and inserting into admin object
        if (citizenfxData) {
            const existingCitizenFX = this.getAdminByProviderUID(citizenfxData.id);
            if (existingCitizenFX) throw new Error('CitizenFX ID already taken');
            admin.providers.citizenfx = {
                id: citizenfxData.id,
                identifier: citizenfxData.identifier,
                data: {},
            };
        }
        if (discordData) {
            const existingDiscord = this.getAdminByProviderUID(discordData.id);
            if (existingDiscord) throw new Error('Discord ID already taken');
            admin.providers.discord = {
                id: discordData.id,
                identifier: discordData.identifier,
                data: {},
            };
        }

        //Saving admin file
        this.admins.push(admin);
        this.refreshOnlineAdmins().catch();
        try {
            return await this.writeAdminsFile();
        } catch (error) {
            throw new Error(`Failed to save admins.json with error: ${error.message}`);
        }
    }


    /**
     * Edit admin and save to the admins file
     * @param {string} name
     * @param {string} password
     * @param {object} citizenfxData or false
     * @param {object} discordData or false
     * @param {array} permissions
     */
    async editAdmin(name, password, citizenfxData, discordData, permissions) {
        if (this.admins == false) throw new Error('Admins not set');

        //Find admin index
        let username = name.toLowerCase();
        let adminIndex = this.admins.findIndex((user) => {
            return (username === user.name.toLowerCase());
        });
        if (adminIndex == -1) throw new Error('Admin not found');

        //Editing admin
        if (password !== null) {
            this.admins[adminIndex].password_hash = GetPasswordHash(password);
            delete this.admins[adminIndex].password_temporary;
        }
        if (typeof citizenfxData !== 'undefined') {
            if (!citizenfxData) {
                delete this.admins[adminIndex].providers.citizenfx;
            } else {
                this.admins[adminIndex].providers.citizenfx = {
                    id: citizenfxData.id,
                    identifier: citizenfxData.identifier,
                    data: {},
                };
            }
        }
        if (typeof discordData !== 'undefined') {
            if (!discordData) {
                delete this.admins[adminIndex].providers.discord;
            } else {
                this.admins[adminIndex].providers.discord = {
                    id: discordData.id,
                    identifier: discordData.identifier,
                    data: {},
                };
            }
        }
        if (typeof permissions !== 'undefined') this.admins[adminIndex].permissions = permissions;

        //Saving admin file
        this.refreshOnlineAdmins().catch();
        try {
            await this.writeAdminsFile();
            return (password !== null) ? this.admins[adminIndex].password_hash : true;
        } catch (error) {
            throw new Error(`Failed to save admins.json with error: ${error.message}`);
        }
    }


    /**
     * Refreshes admin's social login data
     * TODO: this should be stored on PersistentCache instead of admins.json
     *       otherwise it refreshes the admins connected
     * @param {string} name
     * @param {string} provider
     * @param {string} identifier
     * @param {object} providerData
     */
    async refreshAdminSocialData(name, provider, identifier, providerData) {
        if (this.admins == false) throw new Error('Admins not set');

        //Find admin index
        const username = name.toLowerCase();
        const adminIndex = this.admins.findIndex((user) => {
            return (username === user.name.toLowerCase());
        });
        if (adminIndex == -1) throw new Error('Admin not found');

        //Refresh admin data
        if (!this.admins[adminIndex].providers[provider]) throw new Error('Provider not available for this admin');
        this.admins[adminIndex].providers[provider].identifier = identifier;
        this.admins[adminIndex].providers[provider].data = providerData;

        //Saving admin file
        this.refreshOnlineAdmins().catch();
        try {
            return await this.writeAdminsFile();
        } catch (error) {
            throw new Error(`Failed to save admins.json with error: ${error.message}`);
        }
    }


    /**
     * Delete admin and save to the admins file
     * @param {string} name
     */
    async deleteAdmin(name) {
        if (this.admins == false) throw new Error('Admins not set');

        //Delete admin
        let username = name.toLowerCase();
        let found = false;
        this.admins = this.admins.filter((user) => {
            if (username !== user.name.toLowerCase()) {
                return true;
            } else {
                found = true;
                return false;
            }
        });
        if (!found) throw new Error('Admin not found');

        //Saving admin file
        this.refreshOnlineAdmins().catch();
        try {
            return await this.writeAdminsFile();
        } catch (error) {
            throw new Error(`Failed to save admins.json with error: ${error.message}`);
        }
    }

    /**
     * Loads the admins.json file into the admins list
     * NOTE: The verbosity here is driving me insane.
     *       But still seems not to be enough for people that don't read the README.
     */
    async loadAdminsFile() {
        let raw = null;
        let jsonData = null;
        let migrated = false;

        const callError = (x) => {
            console.error(`Unable to load admins. (${x}, please read the documentation)`);
            process.exit(1);
        };

        try {
            raw = await fsp.readFile(this.adminsFile, 'utf8');
            this.adminsFileHash = createHash('sha1').update(raw).digest('hex');
            if (raw === this.lastAdminFile) {
                console.verbose.log('Admin file didn\'t change, skipping.');
                return;
            }
            this.lastAdminFile = raw;
        } catch (error) {
            return callError('cannot read file');
        }

        try {
            jsonData = JSON.parse(raw);
        } catch (error) {
            return callError('json parse error');
        }

        if (!Array.isArray(jsonData)) {
            return callError('not an array');
        }

        const structureIntegrityTest = jsonData.some((x) => {
            if (typeof x.name !== 'string' || x.name.length < 3) return true;
            if (typeof x.master !== 'boolean') return true;
            if (typeof x.password_hash !== 'string' || !x.password_hash.startsWith('$2')) return true;
            if (typeof x.providers !== 'object') return true;
            const providersTest = Object.keys(x.providers).some((y) => {
                if (!Object.keys(this.providers).includes(y)) return true;
                if (typeof x.providers[y].id !== 'string' || x.providers[y].id.length < 3) return true;
                if (typeof x.providers[y].data !== 'object') return true;
                if (typeof x.providers[y].identifier === 'string') {
                    if (x.providers[y].identifier.length < 3) return true;
                } else {
                    migrateProviderIdentifiers(y, x.providers[y]);
                    migrated = true;
                }
            });
            if (providersTest) return true;
            if (!Array.isArray(x.permissions)) return true;
            return false;
        });
        if (structureIntegrityTest) {
            return callError('invalid data in the admins file');
        }

        const masters = jsonData.filter((x) => { return x.master; });
        if (masters.length !== 1) {
            return callError('must have exactly 1 master account');
        }

        if (!jsonData.length) {
            return callError('no entries');
        }

        this.admins = jsonData;
        this.refreshOnlineAdmins().catch();
        if (migrated) {
            try {
                await this.writeAdminsFile();
                console.ok('The admins.json file was migrated to a new version.');
            } catch (error) {
                console.error(`Failed to migrate admins.json with error: ${error.message}`);
            }
        }

        return true;
    }


    /**
     * Notify game server about admin changes
     */
    async refreshOnlineAdmins() {
        if (globals.playerlistManager === null) return;

        try {
            //Getting all admin identifiers
            const adminIDs = this.admins.reduce((ids, adm) => {
                const adminIDs = Object.keys(adm.providers).map((pName) => adm.providers[pName].identifier);
                return ids.concat(adminIDs);
            }, []);

            //Finding online admins
            const playerList = globals.playerlistManager.getPlayerList();
            const onlineIDs = playerList.filter((p) => {
                return p.ids.some((i) => adminIDs.includes(i));
            }).map((p) => p.netid);

            return globals.fxRunner.sendEvent('adminsUpdated', onlineIDs);
        } catch (error) {
            console.verbose.error('Failed to refreshOnlineAdmins() with error:');
            console.verbose.dir(error);
        }
    }


    /**
     * Returns a random token to be used as CSRF Token
     */
    genCsrfToken() {
        return nanoid();
    }
};
