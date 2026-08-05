function parse(raw) {
  const out = [];
  for (const link of (raw || '').split(/,\s*(?=<)/)) {
    const url = (link.match(/<([^>]+)>/) || [])[1];
    if (!url || !/^(stun|turn|turns):/i.test(url)) continue;
    if (!/rel\s*=\s*"?ice-server"?/i.test(link)) continue;
    const server = { urls: url };
    const user = link.match(/username\s*=\s*"([^"]*)"/i);
    const cred = link.match(/credential\s*=\s*"([^"]*)"/i);
    if (user) server.username = user[1];
    if (cred) server.credential = cred[1];
    out.push(server);
  }
  return out;
}
let fails = 0;
const eq = (got, want, name) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.log(`FAIL ${name}\n  got  ${a}\n  want ${b}`); fails++; }
};
// The shape RFC 9725 shows, and the one MediaMTX emits.
eq(parse('<stun:stun.example.net:3478>; rel="ice-server"'),
   [{urls:'stun:stun.example.net:3478'}], 'bare stun');
// TURN with credentials, and a URL CONTAINING A COMMA-free query.
eq(parse('<turn:t.example.net:3478?transport=udp>; rel="ice-server"; username="u"; credential="p"; credential-type="password"'),
   [{urls:'turn:t.example.net:3478?transport=udp', username:'u', credential:'p'}], 'turn with creds');
// Several links in one header — the split must be on the comma that
// starts the next <...>, not on every comma.
eq(parse('<stun:a:3478>; rel="ice-server", <turn:b:3478>; rel="ice-server"; username="x"; credential="y"'),
   [{urls:'stun:a:3478'},{urls:'turn:b:3478',username:'x',credential:'y'}], 'two links');
// A Link header that is NOT an ice-server must be ignored, not fed to
// RTCPeerConnection as a bogus url.
eq(parse('<https://example/doc>; rel="describedby"'), [], 'other rel');
eq(parse('<stun:a:3478>; rel="describedby"'), [], 'stun but wrong rel');
eq(parse(''), [], 'empty');
eq(parse(null), [], 'absent');
console.log(fails ? `${fails} FAILED` : 'ice link parser: all cases pass');
