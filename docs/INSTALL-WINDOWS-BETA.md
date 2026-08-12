# Installing OpenUI on Windows (Beta)

> **Why this page exists:** the beta builds of OpenUI are **not code-signed**.
> Windows SmartScreen will therefore warn you the first time you run the
> installer — a blue box saying *"Windows protected your PC"* with
> **Unknown publisher**.
>
> This is expected for a beta and does **not** mean the app is unsafe. It means
> nobody has paid a certificate authority to vouch for the publisher name yet.
> Follow the steps below to install. You only need to do this **once** — after
> the first install, future auto-updates apply without the prompt.

---

## Which download do I want?

Grab the latest installer from the
[Releases page](https://github.com/Satyabrat2005/Openui/releases):

| File | Notes |
| --- | --- |
| `OpenUI-Setup-<version>.exe` | The only Windows download you need. Contains both 64-bit and 32-bit builds and picks the right one automatically. |

You do **not** need to choose an architecture — unlike the macOS `.dmg`, the
Windows installer is a single file for both.

---

## Installing past the SmartScreen warning

1. Double-click **`OpenUI-Setup-<version>.exe`**.
2. Windows shows a blue **"Windows protected your PC"** box.
3. Click the small **More info** link (it looks like plain text, under the message).
4. A **Run anyway** button appears at the bottom. Click it.
5. The normal OpenUI installer opens — accept the licence, pick a folder, install.

That's it. OpenUI launches when the installer finishes.

> If you don't see **More info**, the dialog you're looking at is probably the
> browser's download warning rather than SmartScreen. In Edge, click the **…**
> next to the download → **Keep** → **Show more** → **Keep anyway**, then run the
> file. Chrome: click the **^** next to the download → **Keep**.

---

## What "unsigned" actually means here

Being unsigned affects **trust signalling**, not what the app does:

- Windows cannot display a verified publisher name, so it shows *Unknown publisher*.
- SmartScreen has no reputation history for the file, so it warns on first run.
- Antivirus tools occasionally flag unsigned installers as "low reputation".
  This is a heuristic about the signature, not a detection of anything in the app.

You can verify you got the file we published rather than a tampered copy by
comparing its hash against the one in the release's `latest.yml` asset. Note
`latest.yml` records a **SHA-512** digest **base64-encoded**, not the hex
SHA-256 that `Get-FileHash` prints by default, so use this:

```powershell
$fs = [System.IO.File]::OpenRead("OpenUI-Setup-7.2.0.exe"); $h = [System.Security.Cryptography.SHA512]::Create().ComputeHash($fs); $fs.Close(); [Convert]::ToBase64String($h)
```

(Substitute the filename you actually downloaded — the installer is named
`OpenUI-Setup-<version>.exe`.)

It must equal the `sha512:` value for the `.exe` entry in `latest.yml` on the
same release. (Download `latest.yml` from the release's asset list — it's a
plain text file.) For **v7.2.0** the expected value is:

```
d+QEAYLIXiNzTmJ1U5duYUFo2urDttal5XG7WxNxobqJ9o35V/xf1Z+8SiAc19ssf1Df7WO+21p9hWzUMa4QIA==
```

verified against the published asset (364,864,698 bytes) on 2026-08-12.

---

## Auto-updates

Once OpenUI is installed, **updates are automatic** — you do not repeat these
steps for future versions. OpenUI checks GitHub Releases, downloads in the
background, and applies the update on restart. The SmartScreen prompt only
happens on that first manual install.

---

## Prerequisite: the local AI engine

OpenUI runs its models locally through **[Ollama](https://ollama.com/download)**.
The installer does **not** bundle or install it, and the app does not download
models for you.

1. Install Ollama from <https://ollama.com/download>.
2. Pull the two models OpenUI uses:

```bash
ollama pull qwen3.5
```

```bash
ollama pull qwen2.5-coder:7b
```

Without these, OpenUI starts but chat and the builder report that the local
engine or model is unavailable. OpenUI starts the Ollama *service* for you if
it's installed but not running — it cannot install Ollama or fetch models.

---

## Troubleshooting

**"Windows protected your PC" with no "Run anyway" button.**
Your organisation may enforce SmartScreen via policy. On a managed work machine
you'll need IT to allow the file; there is no user-side override.

**The installer runs but the app won't start.**
Check that no previous OpenUI process is still running (Task Manager →
Details → `OpenUI.exe`), then relaunch.

**Antivirus quarantined the installer.**
Restore it from the AV's quarantine list and re-run. Verify the hash first using
the command above if you want to be certain of the file's integrity.

**Still stuck?**
Open an issue at <https://github.com/Satyabrat2005/Openui/issues> with your
Windows version (`winver`) and a screenshot of the error.

---

*macOS users:* see [INSTALL-MACOS-BETA.md](INSTALL-MACOS-BETA.md) — the
equivalent there is Gatekeeper rather than SmartScreen.
