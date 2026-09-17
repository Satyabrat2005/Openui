# Third-party model notices

OpenUI's assistant, **Splen**, runs on an open-weight language model that
OpenUI fine-tuned from a third party's model. OpenUI does not redistribute
these weights inside the installer; they are downloaded on your machine from the
Ollama model registry when you choose to install them. They are listed here so
the provenance and licence of the model you are running are always visible.

Splen is OpenUI's assistant: OpenUI's instructions, tools, safety rules and
confirmation gates, running on Splen 4B — Qwen3.5-4B further trained by OpenUI
on texting tasks. It is **not** a model trained from scratch by OpenUI.

---

## Splen 4B — the model Splen runs on

| | |
|---|---|
| Used for | Splen (reading, summarising and replying to messages) |
| Ollama tag | `openui/splen:4b` |
| Weights digest | `sha256:0db1fd5a145d5496b06e1ad338a097c36c9fefabbd2fadf65d4a67cb9c779b85` |
| Made by | OpenUI: a LoRA fine-tune of Qwen3.5-4B, merged and quantised to Q4_K_M |
| Base model | Qwen3.5-4B by Alibaba Cloud (Qwen team), Hugging Face `Qwen/Qwen3.5-4B` at `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a` |
| Licence | Apache License, Version 2.0 |
| Licence text digest | `sha256:eb28c3538bdcf5c21ebd7b04e74bf039e3787cff3d640d0bec1f73b8d8793005` |

Splen 4B's licence layer states the modification notice ("a fine-tuned
derivative of Qwen3.5-4B … Modifications Copyright OpenUI. It is not endorsed by
the Qwen team.") followed by the unmodified Apache License 2.0 text of the base.

## Qwen2.5-Coder 7B — coding model (switched off in this build)

| | |
|---|---|
| Ollama tag | `qwen2.5-coder:7b` |
| Weights digest | `sha256:60e05f2100071479f596b964f89f510f057ce397ea22f2833a0cfe029bfc2463` |
| Author | Alibaba Cloud (Qwen team) |
| Licence | Apache License, Version 2.0 |
| Licence text digest | `sha256:832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e` |

The digests are the exact layers recorded when the licence was checked
(`scripts/finetune/base-provenance.json`), so a later, different upload under
the same tag is detectable.

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
