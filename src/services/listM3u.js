'use strict';

const playlist = require('../playlist');
const { flattenStations } = require('../wiseplay');
const { makeBranchSelector } = require('../selection');
const { normalizeStreamUrl } = require('../protocols');
const { buildM3U } = require('../m3u');

/**
 * Builds the M3U playlist of a single list (preview or personal list).
 *
 * @param {object} cfg current configuration
 * @param {object} list list to export
 * @param {string} [onlyPath] optional branch path to restrict the export
 * @returns {Promise<string>} M3U content
 */
async function buildListM3U(cfg, list, onlyPath = '') {
  const selector = onlyPath
    ? (path) => path === onlyPath || path.startsWith(`${onlyPath}.`)
    : makeBranchSelector(list.options.disabledPaths);

  const entry = await playlist.entryFor(cfg, list);
  const prefix = playlist.listPrefix(list);

  const raw = flattenStations(entry.tree, selector, {
    maxDepth: list.options.groupDepth,
    joiner: playlist.JOINER,
    prefix,
    emitLogo: !!list.options.emitLogo,
    renames: list.options.renames,
    disabledChannels: list.options.disabledChannels,
    deletedChannels: list.options.deletedChannels,
    deletedBranches: list.options.deletedBranches,
    channelRenames: list.options.channelRenames,
    channelMoves: list.options.channelMoves,
  });

  const channels = raw
    .map((channel) => ({
      ...channel,
      url: playlist.proxyStreamUrl(normalizeStreamUrl(channel.url, list.options), list),
    }))
    .filter((channel) => channel.url)
    .map((channel) => ({
      name: channel.name,
      url: channel.url,
      logo: channel.logo,
      group: channel.group || prefix,
    }));

  // Preview/dedicated lists also declare the EPG (manual + inherited from m3u).
  const listEpg = (entry.tree && entry.tree.meta && entry.tree.meta.epgUrls) || [];
  return buildM3U(channels, {
    name: `${prefix} (${channels.length} channels)`,
    header: playlist.epgHeader(cfg, listEpg),
  });
}

module.exports = { buildListM3U };
