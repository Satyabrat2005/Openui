# Third-party model notices

OpenUI's assistant, **Splen**, runs on open-weight language models. They are
listed here so the provenance and licence of the model you are running are
always visible.

Splen is OpenUI's assistant: OpenUI's instructions, tools, safety rules and
confirmation gates, running on one of the models below. **Splen 4B** is
Qwen3.5-4B further trained by OpenUI on texting tasks; it is
**not** a model trained from scratch by OpenUI. Neither model is inside the
installer: each is downloaded on your machine when you choose to install it.

---

## Splen 4B — OpenUI's own model

| | |
|---|---|
| Used for | Splen (reading, summarising and replying to messages), when downloaded |
| Delivered by | OpenUI, after sign-in; runs inside OpenUI, not through Ollama |
| Weights digest | `sha256:0db1fd5a145d5496b06e1ad338a097c36c9fefabbd2fadf65d4a67cb9c779b85` |
| Made by | OpenUI: a LoRA fine-tune of Qwen3.5-4B, merged and quantised to Q4_K_M |
| Base model | Qwen3.5-4B by Alibaba Cloud (Qwen team), Hugging Face `Qwen/Qwen3.5-4B` at `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a` |
| Licence | Apache License, Version 2.0 — full text in `licenses/Qwen3.5-4B-LICENSE.txt` beside this file |
| Licence text digest | `sha256:bbedc3fda3305820b977265f01b8619d87570a6739de3a5582c3464840f1e57a` |

Splen 4B is a fine-tuned derivative of Qwen3.5-4B (Copyright Alibaba Cloud /
Qwen team), used under the Apache License, Version 2.0. Modifications Copyright
OpenUI. It is not endorsed by the Qwen team. OpenUI checks the digest above
before it will run a downloaded file.

## Qwen3.5 — the standard model

| | |
|---|---|
| Used for | Splen when Splen 4B is not downloaded |
| Ollama tag | `qwen3.5:latest` |
| Weights digest | `sha256:dec52a44569a2a25341c4e4d3fee25846eed4f6f0b936278e3a3c900bb99d37c` |
| Author | Alibaba Cloud (Qwen team) |
| Licence | Apache License, Version 2.0 |
| Licence text digest | `sha256:7339fa418c9ad3e8e12e74ad0fd26a9cc4be8703f9c110728a992b193be85cb2` |

## Qwen2.5-Coder 7B — coding model (switched off in this build)

| | |
|---|---|
| Ollama tag | `qwen2.5-coder:7b` |
| Weights digest | `sha256:60e05f2100071479f596b964f89f510f057ce397ea22f2833a0cfe029bfc2463` |
| Author | Alibaba Cloud (Qwen team) |
| Licence | Apache License, Version 2.0 |
| Licence text digest | `sha256:832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e` |

The Ollama digests are the exact layers the Ollama registry served when the
licence was checked (`scripts/finetune/base-provenance.json`), so a later,
different upload under the same tag is detectable.

---

## Apache License 2.0 — summary of your rights and obligations

The full licence text ships with OpenUI (`licenses/Qwen3.5-4B-LICENSE.txt`), is
distributed with each Ollama model in its licence layer, and is available at
<https://www.apache.org/licenses/LICENSE-2.0>. In short: the models may be used,
modified and redistributed, including commercially, provided the licence and
any NOTICE are retained. The licence grants no rights to the licensors'
trademarks (§6), and the models are provided "AS IS", without warranties of any
kind (§7).

"Qwen" is a trademark of its owner. Its use here is purely descriptive and
implies no endorsement of OpenUI.
