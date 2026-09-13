# Third-party model notices

OpenUI's assistant, **Splen**, runs on open-weight language models made by
third parties. OpenUI does not redistribute these weights inside the installer;
they are downloaded on your machine from the Ollama model registry when you
choose to install them. They are listed here so the provenance and licence of
the model you are running are always visible.

Splen is OpenUI's assistant: OpenUI's instructions, tools, safety rules and
confirmation gates, running on the model below. It is **not** a model trained
from scratch by OpenUI.

---

## Qwen3.5 — the model Splen runs on

| | |
|---|---|
| Used for | Splen (reading, summarising and replying to messages) |
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

The digests are the exact layers the Ollama registry served when the licence
was checked (`scripts/finetune/base-provenance.json`), so a later, different
upload under the same tag is detectable.

---

## Apache License 2.0 — summary of your rights and obligations

The full licence text is distributed with each model by Ollama (see the model's
licence layer) and is available at <https://www.apache.org/licenses/LICENSE-2.0>.
In short: the models may be used, modified and redistributed, including
commercially, provided the licence and any NOTICE are retained. The licence
grants no rights to the licensors' trademarks (§6), and the models are provided
"AS IS", without warranties of any kind (§7).

"Qwen" is a trademark of its owner. Its use here is purely descriptive and
implies no endorsement of OpenUI.
