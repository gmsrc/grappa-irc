// The exact logic out of room.html, exercised on the case that produced
// the echo: the link spells a nick one way, the user types it another.
const pathNick = n => [...n.toLowerCase()].map(c =>
  /[a-z0-9._~-]/.test(c) ? c
    : '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('');

let fails = 0;
const ok = (cond, name) => { if (!cond) { console.log('FAIL ' + name); fails++; } };

function joinAs(linkPeers, typed) {
  // The posted invite carries no `me=`, so the filter keeps EVERYONE —
  // the joiner included. Removing ourselves is entirely down to publish.
  const me = '';
  const wanted = new Set(linkPeers.filter(n => !me || pathNick(n) !== pathNick(me)));
  let publishing = typed;
  for (const n of [...wanted]) if (pathNick(n) === pathNick(typed)) wanted.delete(n);
  // The choke point: what subscribe() would actually accept.
  const wouldSubscribe = [...wanted].filter(
    n => !(publishing && pathNick(n) === pathNick(publishing)));
  return wouldSubscribe;
}

// Exact spelling: the case that always worked.
ok(JSON.stringify(joinAs(['nextime', 'nextime2'], 'nextime2')) === '["nextime"]', 'exact');
// DIFFERENT CASE — the bug. A raw Set.delete misses, the name stays
// wanted, the next sweep subscribes us to our own path, and the SFU
// plays our microphone back at us.
ok(JSON.stringify(joinAs(['nextime', 'nextime2'], 'Nextime2')) === '["nextime"]', 'typed capitalised');
ok(JSON.stringify(joinAs(['nextime', 'NextIme2'], 'nextime2')) === '["nextime"]', 'link capitalised');
// A nick needing percent-encoding folds the same both ways.
ok(JSON.stringify(joinAs(['a|b', 'nextime'], 'A|B')) === '["nextime"]', 'encoded + case');
// Not in the link at all: we still never subscribe to ourselves.
ok(JSON.stringify(joinAs(['nextime'], 'stranger')) === '["nextime"]', 'joiner absent from link');
// And the peer list is otherwise untouched.
ok(JSON.stringify(joinAs(['a', 'b', 'c'], 'b')) === '["a","c"]', 'others preserved');
console.log(fails ? fails + ' FAILED' : 'self-subscribe guard: all cases pass');
