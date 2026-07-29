# Per-client derived source addresses

**Audience:** IRC network operators and staff evaluating whether to let a grappa instance connect to their network.
> **Status: design, not yet shipped.** The kernel behaviour and the cost figures below are measured on a real host, but the feature itself does not exist in any release. It is tracked in [#454](https://github.com/vjt/grappa-irc/issues/454) (the derivation and its rulings) and [#543](https://github.com/vjt/grappa-irc/issues/543) (the operator-facing addressing mode and the per-platform plumbing). Do not read any of this as a description of current behaviour, and do not hand it to a network as a promise: when the code lands, this banner comes off in the same change, and not before.

## The problem this solves

A bouncer is one process serving many people, so by default it is also **one source address** serving many people. That single fact breaks two things at once for the network it connects to:

1. **Your bans and throttles become collateral weapons.** Ban the address, and every user of that bouncer is gone, including the ones who did nothing. Throttle it — bahamut keys connection throttling on the address string — and one person's reconnect storm rate-limits everyone else behind it.
2. **The bouncer becomes a ban-evasion laundromat.** A user you already banned by address connects through the bouncer and arrives wearing an address you never banned. Nothing they did was subtle; the bouncer simply repainted them.

Both problems have the same root: the network cannot tell the bouncer's users apart at the layer where its existing tooling operates. Any fix that stays at the account layer (a per-client `ident`, for example) does not help, because throttling and clone limits key on the address, and an `ident` is a client-supplied string that a network has no reason to trust from a third party.

## The mechanism

The instance is given a routed IPv6 block — a `/72` — and **derives one address inside it per client**, deterministically, from that client's own real source address:

```
derived = block_prefix || H_key(client /32) || H_key(client /48) || H_key(client /64)
                          24 bits             24 bits             8 bits
```

`H_key` is a keyed hash with an instance-level key that does not rotate. For IPv4 clients the same three-level shape applies to `/16`, `/24`, and the host address, and addresses are canonicalized first so that a v4-mapped-in-v6 client cannot pick up a second identity by changing how it connects.

Three properties follow, and they are the whole point:

- **Stable.** The same client always arrives as the same address, so a ban you set stays effective and a throttle key keeps counting the right person. The hash deliberately ignores the interface ID, because clients rotate temporary addresses (RFC 8981) roughly daily; hashing the full 128 bits would silently expire every ban you set.
- **Deterministic from the client's real address.** A user cannot shed their derived address without changing the address you would have banned anyway. That is the anti-evasion half: the bouncer stops laundering identity.
- **Hierarchical, so escalation works at the granularity you already use.** The high bits come from the client's upstream allocation, the low bits from the client itself.

| ban this | catches |
| --- | --- |
| the derived `/128` | one client |
| the derived `/120` | one customer site (the client's `/48`) |
| the derived `/96` | one upstream allocation (the client's `/32`) |
| the whole `/72` | every derived session on the instance |

That last row is the honest one: banning the block is always available, and it is exactly as blunt as banning a bouncer is today. The other three rows are what the feature adds.

## What it does not do, stated plainly

- **It is not a privacy or cloaking mechanism, and it is not sold as one.** Derived addresses that share high bits do tell you "same upstream allocation" — that is the escalation feature working as designed, not a leak. Cloaking, if a network wants it, is the network's job and is applied on top.
- **Derived addresses have no PTR.** Reverse DNS is per-address and this space is combinatorial, so anything that expects forward-confirmed reverse DNS from a derived source will fail. Curated, named addresses — the ones an instance reserves for specific users — keep their PTR and their FCrDNS. If your network requires FCrDNS, you get the curated block, not the derived one.
- **A client with a large delegation can still move.** An ISP that delegates a `/56` or a `/48` to the customer lets that customer hop `/64`s and collect a fresh derived address each time. No choice of hash input prevents this. The answer is the escalation ladder above: ban the derived `/120` and the whole delegation is covered.
- **IPv4 behind CGNAT collapses, and that limit is real.** Thousands of subscribers sharing one carrier address hash to one derived address, so for those clients the collateral problem is reduced to the same granularity your own IPv4 bans already have — no worse than today, but no better either. The full benefit is an IPv6 benefit.
- **It does not make the operator trustworthy.** It makes the operator's users *separable*, which is the part you can verify from the outside: ban one derived address, observe that exactly one client loses its connection.

## Reservations

Named addresses (vanity reverse DNS, per-user assignments) are granted explicitly and **win over derivation**. They live outside the derived block so that a derivation can never land on an address reserved for someone else — two users sharing an address is precisely the collateral this feature exists to remove. In this mode there is **no random pool**: a user either holds a reservation or arrives on their derived address. Nobody gets an address that was somebody else's yesterday.

## Operational cost, measured

Reference figures from a FreeBSD 14.3 host, 5000 concurrent derived addresses:

| measurement | result |
| --- | --- |
| configure 5000 addresses | ~30s total, cost per address linear in list length (2ms at 1k, 9ms at 5k) |
| add one more with 5000 present | 11ms |
| outbound `connect` latency with 5000 present | 5-6ms, indistinguishable from baseline |
| kernel memory for 5000 | ~4MB, fully reclaimed on removal |

The size of the address *space* is not the cost; the number of *live sessions* is. Linux needs no per-session work at all (the whole prefix is made locally deliverable with AnyIP, plus non-local bind for the outbound half). FreeBSD has no AnyIP equivalent — measured, including the non-local bind option, which fixes the bind and then leaves the return path broken — so each live derived address is configured on the loopback for the lifetime of the session and swept on restart.

## What we ask of a network, and what we offer

We are not asking for an exemption. We are asking that the exemption you might otherwise have to grant a bouncer — "please do not ban this address, there are innocents behind it" — becomes unnecessary, because you can ban the guilty client and only the guilty client.

In return we expect to be held to it: if a derived address misbehaves, ban it and it stays banned; if the escalation is not doing what this document says, that is a bug and we want the report.

One requirement we are placing on ourselves, worth stating because it protects your users too: any interface that offers a prefix-level ban has to report **how many live sessions the candidate prefix would hit before it is set**. Escalation power without a blast-radius number is a footgun for everyone.
