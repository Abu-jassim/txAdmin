const modulename = 'WebServer:DatabaseActions';
import { GenericApiResp } from '@shared/genericApiTypes';
import { Context } from 'koa';
import { DatabaseActionType } from '@core/components/PlayerDatabase/databaseTypes';
import { calcExpirationFromDuration } from '@core/extras/helpers';
import consts from '@core/extras/consts';
import humanizeDuration, { Unit } from 'humanize-duration';
import consoleFactory from '@extras/console';
const console = consoleFactory(modulename);

//Helper functions
const anyUndefined = (...args: any) => { return [...args].some((x) => (typeof x === 'undefined')); };


/**
 * Returns the resources list
 * @param {object} ctx
 */
export default async function DatabaseActions(ctx: Context) {
    //Sanity check
    if (!ctx.params?.action) {
        return ctx.utils.error(400, 'Invalid Request');
    }
    const action = ctx.params.action;
    const sess = ctx.nuiSession ?? ctx.session; //revoke_action can be triggered by the menu player modal
    const sendTypedResp = (data: GenericApiResp) => ctx.send(data);

    //Delegate to the specific action handler
    if (action === 'ban_ids') {
        return sendTypedResp(await handleBandIds(ctx, sess));
    } else if (action === 'revoke_action') {
        return sendTypedResp(await handleRevokeAction(ctx, sess));
    } else {
        return sendTypedResp({ error: 'unknown action' });
    }
};


/**
 * Handle Ban Player IDs (legacy ban!)
 * This is only called from the players page, where you ban an ID array instead of a PlayerClass
 * Doesn't support HWIDs, only banning player does
 */
async function handleBandIds(ctx: Context, sess: any): Promise<GenericApiResp> {
    //Checking request & identifiers
    if (
        anyUndefined(
            ctx.request.body,
            ctx.request.body.identifiers,
            ctx.request.body.duration,
            ctx.request.body.reason,
        )
    ) {
        return { error: 'Invalid request.' };
    }
    const identifiers = ctx.request.body.identifiers;
    const durationInput = ctx.request.body.duration.trim();
    const reason = (ctx.request.body.reason as string).trim() || 'no reason provided';

    //Filtering identifiers
    if (Array.isArray(identifiers)) {
        if (!identifiers.length) {
            return { error: 'You must send at least one identifier' };
        }
        const invalids = identifiers.filter((id) => {
            return (typeof id !== 'string') || !Object.values(consts.validIdentifiers).some((vf) => vf.test(id));
        });
        if (invalids.length) {
            return { error: 'Invalid identifiers: ' + invalids.join(', ') };
        }
    } else {
        return { error: `identifiers expected to be an array, got ${typeof identifiers}` };
    }

    //Calculating expiration/duration
    let calcResults;
    try {
        calcResults = calcExpirationFromDuration(durationInput);
    } catch (error) {
        return { error: (error as Error).message };
    }
    const { expiration, duration } = calcResults;

    //Check permissions
    if (!ctx.utils.testPermission('players.ban', modulename)) {
        return { error: 'You don\'t have permission to execute this action.' }
    }

    //Register action
    let actionId;
    try {
        actionId = globals.playerDatabase.registerAction(identifiers, 'ban', sess.auth.username, reason, expiration, false);
    } catch (error) {
        return { error: `Failed to ban identifiers: ${(error as Error).message}` };
    }
    ctx.utils.logAction(`Banned <${identifiers.join(';')}>: ${reason}`);

    //No need to dispatch events if server is not online
    if (globals.fxRunner.fxChild === null) {
        return { success: true };
    }

    try {
        //Prepare and send command
        let kickMessage, durationTranslated;
        const tOptions: any = {
            author: sess.auth.username,
            reason: reason,
        };
        if (expiration !== false && duration) {
            const humanizeOptions = {
                language: globals.translator.t('$meta.humanizer_language'),
                round: true,
                units: ['d', 'h'] as Unit[],
            };
            durationTranslated = humanizeDuration((duration) * 1000, humanizeOptions);
            tOptions.expiration = durationTranslated;
            kickMessage = globals.translator.t('ban_messages.kick_temporary', tOptions);
        } else {
            durationTranslated = null;
            kickMessage = globals.translator.t('ban_messages.kick_permanent', tOptions);
        }

        // Dispatch `txAdmin:events:playerBanned`
        globals.fxRunner.sendEvent('playerBanned', {
            author: sess.auth.username,
            reason,
            actionId,
            expiration,
            durationInput,
            durationTranslated,
            targetNetId: null,
            targetIds: identifiers,
            targetName: 'identifiers',
            kickMessage,
        });
    } catch (error) { }
    return { success: true };
}


/**
 * Handle revoke database action.
 * This is called from the player modal or the players page.
 */
async function handleRevokeAction(ctx: Context, sess: any): Promise<GenericApiResp> {
    //Checking request
    if (anyUndefined(
        ctx.request.body,
        ctx.request.body.action_id,
    )) {
        return { error: 'Invalid request.' };
    }
    const action_id = ctx.request.body.action_id.trim();

    //Check permissions
    const perms = [];
    if (ctx.utils.hasPermission('players.ban')) perms.push('ban');
    if (ctx.utils.hasPermission('players.warn')) perms.push('warn');

    let action;
    try {
        action = globals.playerDatabase.revokeAction(action_id, sess.auth.username, perms) as DatabaseActionType;
        ctx.utils.logAction(`Revoked ${action.type} id ${action_id} from ${action.playerName ?? 'identifiers'}`);
    } catch (error) {
        return { error: `Failed to revoke action: ${(error as Error).message}` };
    }

    //No need to dispatch events if server is not online
    if (globals.fxRunner.fxChild === null) {
        return { success: true };
    }

    try {
        // Dispatch `txAdmin:events:actionRevoked`
        globals.fxRunner.sendEvent('actionRevoked', {
            actionId: action.id,
            actionType: action.type,
            actionReason: action.reason,
            actionAuthor: action.author,
            playerName: action.playerName,
            playerIds: action.identifiers,
            revokedBy: sess.auth.username,
        });
    } catch (error) { }
    return { success: true };
}
