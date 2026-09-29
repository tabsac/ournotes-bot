'use strict';
// Targeted probe: are the player-data RPCs reachable without a login?
const HOST = 'l14-prod-hk-all-gs-sirius.gamerfusiontech.com';
const EMPTY = Buffer.from([0, 0, 0, 0, 0]);

const SERVICES = [
  'app.profilecard.ProfileCardService',
  'app.friend.FriendService',
  'app.player.PlayerService',
  'app.playerext.PlayerExtService',
  'app.home.HomeService',
  'app.ranking.RankingService',
  'app.circleranking.CircleRankingService',
  'app.integrity.IntegrityService',
];
const METHODS = [
  'Get', 'GetProfile', 'GetProfileCard', 'GetProfileCards', 'GetPlayerProfile',
  'GetPlayer', 'GetPlayerData', 'GetPlayerInfo', 'GetPlayerList', 'GetPlayerFavoriteStatus',
  'SearchPlayer', 'Search', 'GetSearchPlayer', 'GetOtherPlayer',
  'GetFriend', 'GetFriendList', 'GetFriendProfile', 'GetFriends', 'GetFriendRequest',
  'GetRanking', 'GetRankingList', 'GetUserInfo', 'GetUser', 'GetAccount',
  'GetLinkedPlayer', 'GetLinkedAccount', 'GetCard', 'GetDetail', 'GetData',
  'Login', 'Ping', 'Version', 'Check', 'GetStatus',
];

async function probe(path) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch('https://' + HOST + path, {
      method: 'POST', headers: { 'content-type': 'application/grpc+proto' }, body: EMPTY, signal: ac.signal,
    });
    const b = Buffer.from(await r.arrayBuffer());
    return { status: r.status, bytes: b.length };
  } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : e.message.slice(0, 60) }; }
  finally { clearTimeout(t); }
}

(async () => {
  const hits = [];
  const targets = [];
  for (const s of SERVICES) for (const m of METHODS) targets.push('/' + s + '/' + m);
  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const p = targets[i++];
      const r = await probe(p);
      if (r.status && r.status !== 404) { hits.push({ path: p, ...r }); console.log('FOUND ' + p + '  ' + JSON.stringify(r)); }
    }
  }
  await Promise.all(Array.from({ length: 10 }, worker));
  console.log('\n%d probes over %d player-data services, %d registered (non-404)',
    targets.length, SERVICES.length, hits.length);
  console.log('free (non-empty body): ' + hits.filter((h) => h.bytes > 0).length);
})().catch((e) => { console.error('FATAL ' + e.stack); process.exitCode = 1; });
