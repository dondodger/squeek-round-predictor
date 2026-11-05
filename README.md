# Squeek Round Predictor

A free prediction game for **Squeekchain**. Every round lasts 10 minutes. Call what
**Squeektoshi the hamster** does in the round, then check your call against the round
result read straight from **SqueekCore** on Sepolia.

Outcomes:

| Call | Meaning |
|---|---|
| 💤 `nap` | 0 wheel passes |
| 🐾 `jog` | 1 – 499 passes |
| 🔥 `zoomies` | 500+ passes |

## How it uses Squeekchain

- `GET https://api.squeekchain.com/v1/status` — live wheel telemetry: `coreStatus`, `rpmMilli`, `cumulativeWorkUnits`, `builder.anchor.blockHeight`, `blockProgress`, `workPerThousandBlocks`.
- `GET https://api.squeekchain.com/v1/core` — round configuration (round duration, genesis timestamp) and `settledThroughRound`.
- `GET https://api.squeekchain.com/v1/settlements` — settled rounds, work added per settlement and the settlement transaction hash.
- `GET https://api.squeekchain.com/v1/economy/state` — SQK supply and block rewards.
- Results are verified against **SqueekCore** `0xfd6c166d4b8e2962e65746a13e5a0797cd4de0c4` on Sepolia (chain id `11155111`); each settled round links to its settlement transaction on Etherscan.

Your call is locked with a **plain wallet signature** (EIP-191 `personal_sign`, zero gas —
no transaction, no private key leaves your wallet) and stored locally against the round
number. Nothing you sign can move funds.

## Run it

```bash
npm start            # http://127.0.0.1:8787
```

Static page with no build step and no dependencies. `server.js` serves `./public` and
exposes a read-only `/proxy/*` passthrough to the Squeekchain public API.

```
public/
  index.html
  style.css
  app.js
server.js
```

## Notes

- Independent community project, not affiliated with the Squeekchain team.
- No account required. Connect any EIP-1193 wallet (MetaMask, Rabby, …) on Sepolia.

## License

MIT
