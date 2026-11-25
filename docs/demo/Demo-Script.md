# Demo recording script: Fin × MeshMesh PoC

A natural, full-screen recording of one real run, done by a person in a normal browser. About **8–10 minutes raw**, or **4–5 minutes** after trimming the build wait.

---

## A. Before you record (5 minutes)

**1. System on.** (Already done on 22 Nov. Re-check if the laptop slept.)
- Bridge running: open `http://localhost:8787/health`. It should show `"ok":true` and `"meshmesh_authorised":true`.
- Tunnel running: Intercom's connector points to the cloudflared URL. If the laptop restarted, the URL changed. See the technical guide §9, "Connector times out".
- Procedure **Salesforce Setup Assistant (MeshMesh PoC)**: *Fin availability = Enabled*, published. Audience = Fin PoC tester (jane.doe@test.com), channel = Web.

**2. Screen.**
- Use Chrome or Edge, **full screen (F11)**, zoom 100–110 %, bookmarks bar hidden.
- Turn on **Do not disturb** (Windows: Settings → System → Notifications) so no pop-ups appear.
- Close unrelated tabs, and use a plain desktop wallpaper.

**3. Tabs, in this order.**
1. **Salesforce Setup**: Object Manager → Account → Fields & Relationships (signed in as admin).
2. **FIN Agent site**: `https://orgfarm-8414c843e4-dev-ed.develop.my.site.com/?intercomTest=true&messenger_environment=vjterkovfg`, signed in as the community user (the Messenger identifies you as jane.doe@test.com).
3. *(Optional, adds credibility)* a **PowerShell window** in the bridge folder running `.\scripts\watch-log.ps1`. It prints each step live: Fin → bridge → MeshMesh → Salesforce check → Fin.

**4. Pick the recorder.**
- **Option 1, built into Windows:** Snipping Tool → press **Win + Shift + R** → drag over the whole screen (or pick the full-screen option) → **Start**. Toggle the mic icon if you'll narrate. Press Stop on the toolbar when done. It saves to Videos\Screen Recordings.
- **Option 2, script (tested at 1920×1200, 30 fps):** in a PowerShell window in the bridge folder:
  ```powershell
  .\scripts\record-demo.ps1
  ```
  To include your mic, list the mics with `.\scripts\record-demo.ps1 -ListMics`, then run `.\scripts\record-demo.ps1 -Mic "<name>"`. **Press q** in that window to stop. It saves `Fin-MeshMesh-Demo-<date>.mp4` on your Desktop. Minimise the window after starting.

---

## B. Scenes (type the messages yourself; don't paste whole paragraphs at once)

| # | Show | Do / type | What the viewer sees |
|---|---|---|---|
| 1 | Salesforce tab | In Fields & Relationships, type **Next Renewal Date** in Quick Find | "No items to display": the field doesn't exist yet |
| 2 | FIN Agent site | Open the Messenger → **Messages → Ask a question**. Type: `Hi, can you add a field called Next Renewal Date to our Accounts in Salesforce?` | Fin offers to do it and asks only for the missing details (POC-01/02) |
| 3 | same | Answer what Fin asks, for example: `It's a Date field. Give the Fin PoC Access permission set access. My email is jane.doe@test.com. The reason is to plan renewal outreach.` | Fin shows a **summary** and asks for a clear yes |
| 4 | same | Type `Yes` | **Request ID** (`fmr_…`), then "MeshMesh is planning…" (POC-04/06) |
| 5 | *(optional)* PowerShell log | Switch to the log window for 10–20 s | MeshMesh steps scrolling: plan → build → verify |
| 6 | FIN Agent site | Wait about 4–5 minutes. You can close the Messenger and reopen it later: the result waits there | **Final message:** "complete and independently verified… Next step: assign the permission set" (POC-07) |
| 7 | Salesforce tab | Refresh, search **Next Renewal Date** again → click it | The field exists, type Date |
| 8 | Salesforce tab | Setup → Permission Sets → **Fin PoC Access** → Object Settings → Accounts | Next Renewal Date shows **Read ✓ Edit ✓** (POC-05) |
| 9 | FIN Agent site | New conversation: `Please add a Text field called PoC Customer Tier to Account, give Fin PoC Access access. My email is jane.doe@test.com. Reason: demo of a duplicate.` → `Yes` | Fin says the field **already exists and nothing was changed** (POC-08) |
| 10 | *(optional)* same | New conversation with email `ops@unknown-co.io` | Fin says the company's sandbox **isn't connected** and how to connect it (POC-03) |

**Tips for a natural look:** move the mouse normally, pause a second before clicking, and let Fin's replies finish before you scroll. Use the same browser all the way through. Don't show the Intercom admin screens or the `.env` file.

**Trim the wait:** open the video in **Clipchamp** (built into Windows) → split → delete the quiet part of scene 6, or speed it up to 8×. Keep a few seconds of "Waiting for an update…" so it's clear time passed.

---

## C. After recording
1. Stop the recorder (Snipping Tool: Stop; script: **q**).
2. **Switch the Procedure off:** Intercom → Fin AI Agent → Train → Procedures → *Salesforce Setup Assistant (MeshMesh PoC)* → **Fin availability → Disabled** → **Save to Fin Main**.
3. *(Optional)* Delete the demo field in Salesforce if you want to re-record with the same name: Object Manager → Account → Next Renewal Date → Delete.
4. Share the MP4. It's large, so keep it **out of git**: upload it to SharePoint or OneDrive and put the link in the readout.

## Narration (optional, about 30 s of talking in total)
- *Scene 2:* "A customer asks Fin, in plain language, to change their Salesforce org."
- *Scene 4:* "Fin confirms the details, gets an explicit yes, and hands the job to MeshMesh. Here's the request ID."
- *Scene 6:* "MeshMesh plans, builds and checks the change. Our bridge then checks Salesforce independently before Fin says it's done."
- *Scene 9:* "If something would overwrite an existing field, it's refused and nothing changes."
