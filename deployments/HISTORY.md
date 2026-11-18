# Deployment history (Aevum Testnet, chain 44005)

The current deployment is in [deployments.json](deployments.json) and the [README](../README.md#deployed-on-aevum-testnet).

| Date (UTC) | Contracts | Status |
|---|---|---|
| 2026-11-18 14:55 | **Kindly** `0x944e66ba2642a2e83453e62bb48906f22eecb1b3` (tx `0x760d8c89a19afa97b4062a23bc928a02d087f1e29154ba0db6749c2d8ba5efb6`), PayeeRegistry `0xff6ce066fa19b68bd3150b8a2f0eff477fad2679` (tx `0x0c88ed18075ae3c194d94a4dcd40291d49be77f5933211e6dea38abb9c7a2107`) | **Current.** Invoice Safety Gate, holds and live mandate controls. e2e: 25 txs, all successful, every token refunded. |
| 2026-11-18 14:37 | PayeeRegistry `0x59bbb0171b29fea642227fa440f4e9e294fb79cc` (tx `0x4e30b7ec89abb308125eb8308c111faa68990b4cb4c9820f4762ab64b837a49a`), invoice contract `0xb1f36bfa8f67702ca98fdd32e58e08bed607d604` (tx `0x5e8d8d72dab8caac6187c74cd1115727183bdf83c37d0c01b97a561f2899ae71`) | **Superseded.** Earlier working name, before the Safety Gate existed: hard mandate limits only, with no PAY/HOLD/REJECT decisions. Its e2e ran 13 txs, all successful. Kept here for transparency. |
| 2026-11-18 14:34 | PayeeRegistry `0x8980efc2af909e5e6ff9e3ce01aef3070f71b550` (tx `0x42329798cf9744108aadd9463507c81f8d44685ba5e5aae2a23f81c58cb97fab`), invoice contract `0x6d8f38f37fe5e0508466ced1c44f241bfbb8dd2c` (tx `0x735d9249c59d6b939dcd3946777446f40f68ba4daf155c5adb8f6c978f6b2fe0`) | **Superseded.** First working name. No invoices were ever created on it. |
