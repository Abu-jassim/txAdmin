const modulename = 'WebServer:SettingsSave';
import fsp from 'node:fs/promises';
import path from 'node:path';
import slash from 'slash';
import { parseSchedule, anyUndefined } from '@core/extras/helpers';
import { resolveCFGFilePath } from '@core/extras/fxsConfigHelper';
import { Context } from 'koa';
import ConfigVault from '@core/components/ConfigVault';
import DiscordBot from '@core/components/DiscordBot';
import { generateStatusMessage } from '@core/components/DiscordBot/commands/status';
import consoleFactory from '@extras/console';
const console = consoleFactory(modulename);


//Helper functions
const isUndefined = (x: unknown) => (typeof x === 'undefined');

/**
 * Handle all the server control actions
 * @param {object} ctx
 */
export default async function SettingsSave(ctx: Context) {
    //Sanity check
    if (isUndefined(ctx.params.scope)) {
        return ctx.utils.error(400, 'Invalid Request');
    }
    let scope = ctx.params.scope;

    //Check permissions
    if (!ctx.utils.testPermission('settings.write', modulename)) {
        return ctx.send({
            type: 'danger',
            message: 'You don\'t have permission to execute this action.',
        });
    }

    //Delegate to the specific scope functions
    if (scope == 'global') {
        return await handleGlobal(ctx);
    } else if (scope == 'fxserver') {
        return await handleFXServer(ctx);
    } else if (scope == 'playerDatabase') {
        return await handlePlayerDatabase(ctx);
    } else if (scope == 'monitor') {
        return await handleMonitor(ctx);
    } else if (scope == 'discord') {
        return await handleDiscord(ctx);
    } else if (scope == 'menu') {
        return await handleMenu(ctx);
    } else {
        return ctx.send({
            type: 'danger',
            message: 'Unknown settings scope.',
        });
    }
};


//================================================================
/**
 * Handle Global settings
 * @param {object} ctx
 */
async function handleGlobal(ctx: Context) {
    //Sanity check
    if (
        isUndefined(ctx.request.body.serverName)
        || isUndefined(ctx.request.body.language)
    ) {
        return ctx.utils.error(400, 'Invalid Request - missing parameters');
    }

    //Prepare body input
    const cfg = {
        serverName: ctx.request.body.serverName.trim(),
        language: ctx.request.body.language.trim(),
    };

    //Trying to load language file
    try {
        globals.translator.getLanguagePhrases(cfg.language);
    } catch (error) {
        return ctx.send({
            type: 'danger',
            markdown: true,
            message: `**Language error:** ${(error as Error).message}`
        });
    }

    //Preparing & saving config
    const newConfig = globals.configVault.getScopedStructure('global');
    newConfig.serverName = cfg.serverName;
    newConfig.language = cfg.language;
    try {
        globals.configVault.saveProfile('global', newConfig);
    } catch (error) {
        console.warn(`[${ctx.session.auth.username}] Error changing global settings.`);
        console.verbose.dir(error);
        return ctx.send({
            type: 'danger',
            markdown: true,
            message: `**Error saving the configuration file:** ${(error as Error).message}`
        });
    }

    //Sending output
    globals.func_txAdminRefreshConfig()
    globals.translator.refreshConfig();
    ctx.utils.logAction('Changing global settings.');
    return ctx.send({ type: 'success', markdown: true, message: '**Global configuration saved!**' });
}


//================================================================
/**
 * Handle FXServer settings
 * @param {object} ctx
 */
async function handleFXServer(ctx: Context) {
    //Sanity check
    if (
        isUndefined(ctx.request.body.serverDataPath)
        || isUndefined(ctx.request.body.cfgPath)
        || isUndefined(ctx.request.body.commandLine)
        || isUndefined(ctx.request.body.onesync)
        || isUndefined(ctx.request.body.autostart)
        || isUndefined(ctx.request.body.quiet)
    ) {
        return ctx.utils.error(400, 'Invalid Request - missing parameters');
    }

    //Prepare body input
    const cfg = {
        serverDataPath: slash(path.normalize(ctx.request.body.serverDataPath + '/')),
        cfgPath: slash(path.normalize(ctx.request.body.cfgPath)),
        commandLine: ctx.request.body.commandLine.trim(),
        onesync: ctx.request.body.onesync,
        autostart: (ctx.request.body.autostart === 'true'),
        quiet: (ctx.request.body.quiet === 'true'),
    };

    //Validating Base Path
    try {
        const resPath = path.join(cfg.serverDataPath, 'resources');
        const resStat = await fsp.stat(resPath);
        if (!resStat.isDirectory()) {
            throw new Error("Couldn't locate or read a resources folder inside of the base path.");
        }
    } catch (error) {
        const msg = cfg.serverDataPath.includes('resources')
            ? 'Looks like this path is the \'resources\' folder, but the server data path must be the folder that contains the resources folder instead of the resources folder itself.'
            : (error as Error).message;
        return ctx.send({ type: 'danger', message: `<strong>Server Data Folder error:</strong> ${msg}` });
    }

    //Validating CFG Path
    try {
        const cfgFilePath = resolveCFGFilePath(cfg.cfgPath, cfg.serverDataPath);
        const cfgFileStat = await fsp.stat(cfgFilePath);
        if (!cfgFileStat.isFile()) {
            throw new Error('The path provided is not a file');
        }
    } catch (error) {
        return ctx.send({ type: 'danger', message: `<strong>CFG Path error:</strong> ${(error as Error).message}` });
    }

    //Preparing & saving config
    const newConfig = globals.configVault.getScopedStructure('fxRunner');
    newConfig.serverDataPath = cfg.serverDataPath;
    newConfig.cfgPath = cfg.cfgPath;
    newConfig.onesync = cfg.onesync;
    newConfig.autostart = cfg.autostart;
    newConfig.quiet = cfg.quiet;
    newConfig.commandLine = cfg.commandLine;
    try {
        globals.configVault.saveProfile('fxRunner', newConfig);
    } catch (error) {
        console.warn(`[${ctx.session.auth.username}] Error changing FXServer settings.`);
        console.verbose.dir(error);
        return ctx.send({
            type: 'danger',
            markdown: true,
            message: `**Error saving the configuration file:** ${(error as Error).message}`
        });
    }

    //Sending output
    globals.fxRunner.refreshConfig();
    ctx.utils.logAction('Changing fxRunner settings.');
    return ctx.send({
        type: 'success',
        markdown: true,
        message: `**FXServer configuration saved!**
        You need to restart the server for the changes to take effect.`
    });
}


//================================================================
/**
 * Handle Player Database settings
 * @param {object} ctx
 */
async function handlePlayerDatabase(ctx: Context) {
    //Sanity check
    if (anyUndefined(
        ctx.request.body,
        ctx.request.body.onJoinCheckBan,
        ctx.request.body.whitelistMode,
        ctx.request.body.whitelistedDiscordRoles,
        ctx.request.body.whitelistRejectionMessage,
        ctx.request.body.requiredBanHwidMatches,
        ctx.request.body.banRejectionMessage,
    )) {
        return ctx.utils.error(400, 'Invalid Request - missing parameters');
    }

    //Prepare body input
    const cfg = {
        whitelistMode: ctx.request.body.whitelistMode.trim(),
        whitelistRejectionMessage: ctx.request.body.whitelistRejectionMessage.trim(),
        onJoinCheckBan: (ctx.request.body.onJoinCheckBan === 'true'),
        requiredBanHwidMatches: parseInt(ctx.request.body.requiredBanHwidMatches),
        banRejectionMessage: ctx.request.body.banRejectionMessage.trim(),
        whitelistedDiscordRoles: ctx.request.body.whitelistedDiscordRoles
            .split(',')
            .map((x: string) => x.trim())
            .filter((x: string) => x.length),
    };

    //Validating Discord whitelisted roles
    if (cfg.whitelistMode === 'guildRoles' && !cfg.whitelistedDiscordRoles.length) {
        return ctx.send({
            type: 'danger',
            message: 'The whitelisted roles field is required when the whitelist mode is set to Discord Guild Role'
        });
    }
    const invalidRoleInputs = cfg.whitelistedDiscordRoles.filter((x: string) => !/^\d{17,20}$/.test(x));
    if (invalidRoleInputs.length) {
        return ctx.send({
            type: 'danger',
            message: `The whitelist role(s) "${invalidRoleInputs.join(', ')}" do not appear to be valid`
        });
    }

    //Validating HWID bans
    if (typeof cfg.requiredBanHwidMatches !== 'number' || isNaN(cfg.requiredBanHwidMatches)) {
        return ctx.send({ type: 'danger', message: 'requiredBanHwidMatches must be a number.' });
    }
    if (cfg.requiredBanHwidMatches < 0 || cfg.requiredBanHwidMatches > 6) {
        return ctx.send({ type: 'danger', message: 'The Required Ban HWID matches must be between 0 (disabled) and 6.' });
    }

    //Validating custom rejection messages
    if (cfg.whitelistRejectionMessage.length > 512) {
        return ctx.send({ type: 'danger', message: 'The whitelist rejection message must be less than 512 characters.' });
    }
    if (cfg.banRejectionMessage.length > 512) {
        return ctx.send({ type: 'danger', message: 'The ban rejection message must be less than 512 characters.' });
    }

    //Preparing & saving config
    const newConfig = globals.configVault.getScopedStructure('playerDatabase');
    newConfig.onJoinCheckBan = cfg.onJoinCheckBan;
    newConfig.whitelistMode = cfg.whitelistMode;
    newConfig.whitelistedDiscordRoles = cfg.whitelistedDiscordRoles;
    newConfig.whitelistRejectionMessage = cfg.whitelistRejectionMessage;
    newConfig.requiredBanHwidMatches = cfg.requiredBanHwidMatches;
    newConfig.banRejectionMessage = cfg.banRejectionMessage;
    try {
        globals.configVault.saveProfile('playerDatabase', newConfig);
    } catch (error) {
        console.warn(`[${ctx.session.auth.username}] Error changing Player Manager settings.`);
        console.verbose.dir(error);
        return ctx.send({
            type: 'danger',
            markdown: true,
            message: `**Error saving the configuration file:** ${(error as Error).message}`
        });
    }

    //Sending output
    globals.playerDatabase.refreshConfig();
    ctx.utils.logAction('Changing Player Manager settings.');
    return ctx.send({
        type: 'success',
        markdown: true,
        message: `**Player Manager configuration saved!**
        You need to restart the server for the changes to take effect.`
    });
}


//================================================================
/**
 * Handle Monitor settings
 * @param {object} ctx
 */
async function handleMonitor(ctx: Context) {
    //Sanity check
    if (
        isUndefined(ctx.request.body.restarterSchedule),
        isUndefined(ctx.request.body.resourceStartingTolerance)
    ) {
        return ctx.utils.error(400, 'Invalid Request - missing parameters');
    }

    //Prepare body input
    let cfg = {
        restarterSchedule: ctx.request.body.restarterSchedule.split(',').map((x: string) => x.trim()),
        resourceStartingTolerance: parseInt(ctx.request.body.resourceStartingTolerance),
    };

    //Checking if resourceStartingTolerance is valid integer
    if (typeof cfg.resourceStartingTolerance !== 'number' || isNaN(cfg.resourceStartingTolerance)) {
        return ctx.send({ type: 'danger', message: 'resourceStartingTolerance must be a number.' });
    }

    //Validating restart times
    const { valid: validRestartTimes, invalid: invalidRestartTimes } = parseSchedule(cfg.restarterSchedule);
    if (invalidRestartTimes.length) {
        let message = '<strong>The following entries were not recognized as valid 24h times:</strong><br>';
        message += invalidRestartTimes.join('<br>\n');
        return ctx.send({ type: 'danger', message: message });
    }

    //Preparing & saving config
    const newConfig = globals.configVault.getScopedStructure('monitor');
    newConfig.restarterSchedule = validRestartTimes.map(t => t.string);
    newConfig.resourceStartingTolerance = cfg.resourceStartingTolerance;
    try {
        globals.configVault.saveProfile('monitor', newConfig);
    } catch (error) {
        console.warn(`[${ctx.session.auth.username}] Error changing Restarter settings.`);
        console.verbose.dir(error);
        return ctx.send({
            type: 'danger',
            markdown: true,
            message: `**Error saving the configuration file:** ${(error as Error).message}`
        });
    }

    //Sending output
    globals.healthMonitor.refreshConfig();
    globals.scheduler.refreshConfig();
    ctx.utils.logAction('Changing monitor settings.');
    return ctx.send({
        type: 'success',
        markdown: true,
        message: `**Restarter configuration saved!**`
    });
}


//================================================================
/**
 * Handle Discord settings
 * @param {object} ctx
 */
async function handleDiscord(ctx: Context) {
    const configVault = (globals.configVault as ConfigVault);
    const discordBot = (globals.discordBot as DiscordBot);
    //Sanity check
    if (
        isUndefined(ctx.request.body.enabled)
        || isUndefined(ctx.request.body.token)
        || isUndefined(ctx.request.body.guild)
        || isUndefined(ctx.request.body.announceChannel)
        || isUndefined(ctx.request.body.embedJson)
        || isUndefined(ctx.request.body.embedConfigJson)
    ) {
        return ctx.utils.error(400, 'Invalid Request - missing parameters');
    }

    //Prepare body input
    const cfg = {
        enabled: (ctx.request.body.enabled === 'true'),
        token: ctx.request.body.token.trim(),
        guild: ctx.request.body.guild.trim(),
        announceChannel: ctx.request.body.announceChannel.trim(),
        embedJson: ctx.request.body.embedJson.trim(),
        embedConfigJson: ctx.request.body.embedConfigJson.trim(),
    };

    //Validating embed JSONs
    try {
        generateStatusMessage(globals.txAdmin, cfg.embedJson, cfg.embedConfigJson);
    } catch (error) {
        return ctx.send({
            type: 'danger',
            markdown: true,
            message: `**Embed validation failed:**\n${(error as Error).message}`,
        });
    }

    //Preparing & saving config
    const newConfig = configVault.getScopedStructure('discordBot');
    newConfig.enabled = cfg.enabled;
    newConfig.token = cfg.token;
    newConfig.guild = (cfg.guild.length) ? cfg.guild : false;
    newConfig.announceChannel = (cfg.announceChannel.length) ? cfg.announceChannel : false;
    newConfig.embedJson = cfg.embedJson;
    newConfig.embedConfigJson = cfg.embedConfigJson;
    try {
        globals.configVault.saveProfile('discordBot', newConfig);
    } catch (error) {
        console.warn(`[${ctx.session.auth.username}] Error changing Discord settings.`);
        console.verbose.dir(error);
        return ctx.send({
            type: 'danger',
            markdown: true,
            message: `**Error saving the configuration file:** ${(error as Error).message}`
        });
    }

    //Restarting discord bot
    ctx.utils.logAction('Changing discordBot settings.');
    try {
        await discordBot.refreshConfig();
    } catch (error) {
        const errorCode = (error as any).code;
        let extraContext = '';
        if (errorCode === 'DisallowedIntents' || errorCode === 4014) {
            extraContext = `**The bot requires the \`GUILD_MEMBERS\` intent.**
            - Go to the Dev Portal (https://discord.com/developers/applications)
            - Navigate to \`Bot > Privileged Gateway Intents\`.
            - Enable the \`GUILD_MEMBERS\` intent.
            - Save on the dev portal.
            - Go to the \`txAdmin > Settings > Discord Bot\` and press save.`;
        } else if (errorCode === 'CustomNoGuild') {
            const inviteUrl = ('clientId' in (error as any))
                ? `https://discord.com/oauth2/authorize?client_id=${(error as any).clientId}&scope=bot&permissions=0`
                : `https://discordapi.com/permissions.html#0`
            extraContext = `**This usually mean one of the issues below:**
            - **Wrong guild/server ID:** read the description of the guild/server ID setting for more information.
            - **Bot is not in the guild/server:** you need to [INVITE THE BOT](${inviteUrl}) to join the server.
            - **Wrong bot:** you may be using the token of another discord bot.`;
        }
        return ctx.send({
            type: 'danger',
            markdown: true,
            message: `**Error starting the bot:** ${(error as Error).message}\n${extraContext}`.trim()
        });
    }

    //Sending output
    return ctx.send({
        type: 'success',
        markdown: true,
        message: `**Discord configuration saved!**
        If _(and only if)_ the status embed is not being updated, check the System Logs page and make sure there are no embed errors.`
    });
}


//================================================================
/**
 * Handle Menu settings
 * NOTE: scoped inside global settings
 * @param {object} ctx
 */
async function handleMenu(ctx: Context) {
    //Sanity check
    if (
        isUndefined(ctx.request.body.menuEnabled)
        || isUndefined(ctx.request.body.menuAlignRight)
        || isUndefined(ctx.request.body.menuPageKey)
        || isUndefined(ctx.request.body.hideDefaultAnnouncement)
        || isUndefined(ctx.request.body.hideDefaultDirectMessage)
        || isUndefined(ctx.request.body.hideDefaultWarning)
        || isUndefined(ctx.request.body.hideDefaultScheduledRestartWarning)
    ) {
        return ctx.utils.error(400, 'Invalid Request - missing parameters');
    }

    //Prepare body input
    const cfg = {
        menuEnabled: (ctx.request.body.menuEnabled === 'true'),
        menuAlignRight: (ctx.request.body.menuAlignRight === 'true'),
        menuPageKey: ctx.request.body.menuPageKey.trim(),
        hideDefaultAnnouncement: (ctx.request.body.hideDefaultAnnouncement === 'true'),
        hideDefaultDirectMessage: (ctx.request.body.hideDefaultDirectMessage === 'true'),
        hideDefaultWarning: (ctx.request.body.hideDefaultWarning === 'true'),
        hideDefaultScheduledRestartWarning: (ctx.request.body.hideDefaultScheduledRestartWarning === 'true'),
    };

    //Preparing & saving config
    const newConfig = globals.configVault.getScopedStructure('global');
    newConfig.menuEnabled = cfg.menuEnabled;
    newConfig.menuAlignRight = cfg.menuAlignRight;
    newConfig.menuPageKey = cfg.menuPageKey;
    newConfig.hideDefaultAnnouncement = cfg.hideDefaultAnnouncement;
    newConfig.hideDefaultDirectMessage = cfg.hideDefaultDirectMessage;
    newConfig.hideDefaultWarning = cfg.hideDefaultWarning;
    newConfig.hideDefaultScheduledRestartWarning = cfg.hideDefaultScheduledRestartWarning;
    try {
        globals.configVault.saveProfile('global', newConfig);
    } catch (error) {
        console.warn(`[${ctx.session.auth.username}] Error changing Global settings.`);
        console.verbose.dir(error);
        return ctx.send({
            type: 'danger',
            markdown: true,
            message: `**Error saving the configuration file:** ${(error as Error).message}`
        });
    }

    //Sending output
    globals.config = globals.configVault.getScoped('global');
    globals.fxRunner.resetConvars();
    ctx.utils.logAction('Changing menu settings.');
    return ctx.send({
        type: 'success',
        markdown: true,
        message: `**Game configuration saved!**
        You need to restart the server for the changes to take effect.`
    });
}
