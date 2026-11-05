# squeek-round

A **Squeekchain round tool** — one CLI that reads the live wheel, lets you lock a call
for the current 10-minute round, and scores your calls against what the wheel actually
did. Ships with a small dashboard on top of the same data.

Every round of **Squeekchain** lasts 10 minutes. `squeek-round` gives you one command to
answer: *what is the round doing right now, and did my call land?*

| Call | Meaning |
|---|---|
| 💤 `nap` | 0 wheel passes |
| 🐾 `jog` | 1 – 499 passes |
| 🔥 `zoomies` | 500+ passes |

## CLI

```bash
npx squeek-round                 # live round state (round, closes-in, rpm, last settled)
npx squeek-round watch           # stream rounds as they open, print the last outcome
npx squeek-round call zoomies    # lock your call for the current round
npx squeek-round mine            # score every call you locked
npx squeek-round pack            # current round as JSON — feed bots, overlays, streams
npx squeek-round verify 0xSIG    # print the statement behind a signature
```

Example:

```
$ squeek-round
Squeekchain · round state
──────────────────────────────────────────────
  round        254
  closes in    1m 53s
  duration     10 min
  rpm          0.00
  wheel        IDLE
  feed         online (stale > 120s)
  block        366
  settled thru 254

  recent settled rounds
    #210            179 passes  jog
    #209            150 passes  jog
    #205            338 passes  jog
```

`call` renders the exact statement you sign, stores it with its EIP-191 digest in
`~/.squeek-round/calls.json`, and `mine` scores it once the round settles. `pack` is the
machine-readable form of the same state, so a Telegram bot, an OBS overlay or a stream
companion can consume it without touching the API itself.

## Dashboard

```bash
npm start            # http://127.0.0.1:8787
```

`public/` is a static page over the same endpoints — live wheel telemetry, recent settled
rounds with Etherscan links, and a wallet-connect flow that walks through the same
`personal_sign` statement the CLI renders. `server.js` serves `./public` and exposes a
read-only `/proxy/*` passthrough so the page keeps working when a browser blocks a CORS
header.

## How it uses Squeekchain

- `GET https://api.squeekchain.com/v1/status` — wheel telemetry: `coreStatus`, `rpmMilli`, `builder.anchor.blockHeight`, `workPerThousandBlocks`, `measurement.freshness` / `staleAfterSeconds`.
- `GET https://api.squeekchain.com/v1/core` — round configuration (`genesisTimestamp`, `roundDuration`) and `settledThroughRound`.
- `GET https://api.squeekchain.com/v1/settlements` — settled rounds, `workAdded` per settlement and the settlement transaction hash.
- `GET https://api.squeekchain.com/v1/economy/state` — SQK supply and block rewards.
- Results are read against **SqueekCore** `0xfd6c166d4b8e2962e65746a13e5a0797cd4de0c4` on Sepolia (chain id `11155111`); every settled round links to its settlement transaction on Etherscan.

The round number is derived from the chain's own configuration —
`floor((now - genesisTimestamp) / roundDuration)` — not from a local clock offset, so the
CLI and the dashboard agree with the chain.

## Signing

Your call is locked with a plain wallet signature (EIP-191 `personal_sign`, zero gas — no
transaction, no private key leaves your wallet) and stored locally against the round
number. Nothing you sign can move funds. The CLI prints the EIP-191 digest it computed
over the statement so you can check it in any wallet or in `ethers.verifyMessage`.

## Layout

```
bin/squeek-round.js   CLI (status · watch · call · mine · pack · verify)
public/               dashboard (index.html, style.css, app.js)
server.js             static server + read-only /proxy/* passthrough
```

No build step, no dependencies, Node 18+.

## Notes

- Independent community project, not affiliated with the Squeekchain team.
- No account required. Connect any EIP-1193 wallet (MetaMask, Rabby, …) on Sepolia.

## License

MIT

squeekchain-project: 2bf2a5f0-a2d3-42b5-bac6-ce24b755a787
