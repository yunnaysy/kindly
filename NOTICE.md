# Third-party software

All code in this repository was written during the Aevum Builder Challenge #1 build window (Nov 16 – Dec 11, 2026). It uses these libraries, unmodified, as dependencies:

| Dependency | Use | License |
|---|---|---|
| [OpenZeppelin Contracts v5.1.0](https://github.com/OpenZeppelin/openzeppelin-contracts) | `IERC20`, `SafeERC20`, `Ownable`, `Pausable`, `ReentrancyGuard`, `ERC20` (local mock only) | MIT |
| [forge-std](https://github.com/foundry-rs/forge-std) | Solidity test framework | MIT / Apache-2.0 |
| [viem](https://github.com/wevm/viem) | RPC, contract calls, wallet connection | MIT |
| [qrcode](https://github.com/soldair/node-qrcode) | QR codes for payment links | MIT |
| [Vite](https://github.com/vitejs/vite) | Frontend dev server and bundler | MIT |

`contracts/lib/` is not committed. Install it with `npm run deps:contracts`. The libraries keep their own LICENSE files there.
