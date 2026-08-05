// The self tile: our own camera, shown locally, never read back off the
// SFU. Two properties, both of which have already been wrong once.
const pathNick = n => [...n.toLowerCase()].map(c =>
  /[a-z0-9._~-]/.test(c) ? c
    : '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('');

let fails = 0;
const ok = (cond, name) => { if (!cond) { console.log('FAIL ' + name); fails++; } };

// 1. The self tile survives the self-subscribe cleanup.
//
// publish() removes every tile whose name folds to our nick — that is
// what closes the echo subscription the first sweep opened. The self
// tile must NOT be caught by it: it is filed under `<nick> (you)`,
// which is a different thing from the peer `<nick>`. Fold them the same
// and joining would delete the very tile it is about to create.
const selfName = nick => nick + ' (you)';
ok(pathNick(selfName('nextime2')) !== pathNick('nextime2'), 'self tile is not the peer tile');
ok(pathNick(selfName('Nextime2')) !== pathNick('nextime2'), 'nor across capitalisation');
// The space is what separates them, so it must survive the fold as an
// encoded character rather than being dropped.
ok(pathNick(selfName('a')).includes('%20'), 'the separator survives folding');

// 2. A second join retires the first.
//
// An SFU allows ONE publisher per path, so a stale peer connection is
// what refuses the next join — reported as "someone may already be
// using that nick", which reads as though a stranger took it.
function joinTwice(closeFirst) {
  let selfPc = null, open = 0;
  const publish = () => {
    if (closeFirst && selfPc) { selfPc.close(); }
    const pc = { closed: false, close() { if (!this.closed) { this.closed = true; open--; } } };
    open++;
    selfPc = pc;
  };
  publish();            // "join with camera"
  publish();            // then "join, audio only"
  return open;
}
ok(joinTwice(true) === 1, 'one publisher after two joins');
ok(joinTwice(false) === 2, 'without the close, two publishers - the 409');

console.log(fails ? fails + ' FAILED' : 'self tile: all cases pass');
