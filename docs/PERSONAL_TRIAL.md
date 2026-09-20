# Try StillHere yourself

Use this checklist to try the current product and report what feels unclear. Presentation scripts and visual redesign are deferred until after your feedback.

Open [StillHere](https://safety-guard-htn2026.klavander56.chatgpt.site) in two separate browser profiles or a normal and private window. Use your two authorized site accounts, with different StillHere identities for the rider and guardian. Keep both windows open. No participant wallet or SOL is needed for this trial.

Use an ordinary **New journey** with fictional route details and messages. The sample journey does not earn community contribution and cannot use personal-agent delegation.

## 1. Start with a human guardian

1. Rider: select **New journey**, choose two places, and accept the public-record notice. Under **More options**, choose **Every 5 minutes** for the guardian check-in interval to allow setup time. Leave the optional wallet-signed commitment off. Select **Create guarded journey**.
2. Rider: select **Copy guardian invite**. Open that link in the guardian's separate browser session.
3. Guardian: review the rider's profile, accept the community notice and availability checkbox, then select **Apply to guard**.
4. Rider: select **Review**, review the guardian's profile, then **Approve guardian**.
5. Guardian: select **I am here · Check in**. Under **Contribution & chain receipts**, confirm that a guardian check-in was recorded. Approval alone is not a check-in.

Send a short message from each window and confirm that both participants see the conversation.

## 2. Let your personal agent take a turn

The watcher currently supports the verified official **Codex CLI 0.155.1** with your existing ChatGPT login. From PowerShell in your checkout:

```powershell
Set-Location "C:\Users\20120\Desktop\HTN\safety-guard"
npm run codex:demo -- --check
```

This checks the installed CLI and login without a model call. If it fails, keep the displayed error code for feedback; do not change authentication files or paste credentials.

1. Guardian: open **Let my agent help while I rest**, give the agent a recognizable name, choose **20 minutes**, and accept your processing notice. Select **Ask rider to allow handoff**.
2. Rider: review the named request and processing notice, check the permission box, and select **Allow this agent**. Leave automated assistance enabled for this test.
3. Rider: send a fictional concern, for example: “Trial only: the driver took an unfamiliar detour and has not explained it. I feel uneasy and would like help clarifying the route.”
4. Guardian: open **Connect my agent** and select **Download connection file**. Keep this file private.
5. Run the command below in the same PowerShell window as one complete command. Use the file's actual saved location and filename; Downloads is only the example location. If the browser added `(1)` to the filename, include that suffix. If you saved it in the project folder instead, replace the connection path with `".\stillhere-agent-connection.json"`.

```powershell
npm run agent -- watch --connection "$env:USERPROFILE\Downloads\stillhere-agent-connection.json" --allow-processing
```

Expect **Waiting for the first response**, followed by **Personal agent is here** only after the server accepts an assessment. Look for the named agent's question in the conversation and the action record under **Agent service**. Exact wording and interpretation may vary. Agent activity should not increase the human check-in count.

Keep the computer awake, online, and the terminal running. The watcher defaults to 20 minutes and 12 model turns; it stops at either limit, permission expiry, or a failure—whichever happens first. Optional `--max-minutes` and `--max-turns` arguments belong on the same command, not on a separate PowerShell prompt. It uses your own Codex allowance. A 45-second connectivity limit and a maximum 90-second pending-response deadline make interrupted coverage visible; a heartbeat alone does not prove that the model is responding.

## 3. Return, arrive, and say thank you

1. Guardian: select **Resume & check in**. The page should return to human coverage and show **Agent permission withdrawn**. The old connection loses authority; the watcher may stop with a sanitized authorization error. That is expected after human return.
2. Rider: select **I’ve arrived**. The journey closes and contribution allocation becomes available for the human guardian who checked in.
3. Rider: under **Say thank you**, choose a banner and select **Send free banner**. A banner is free and adds no points.
4. Guardian: open **My profile** to inspect contributions and appreciation. A single eligible guardian receives the journey's 25-point/10-reputation allocation once confirmed. Agent actions do not add another reward pool.
5. Open **Contribution & chain receipts → Public guarding history** and use **View receipt** when available. Confirm that the explorer is on **Devnet**. Profile confirmed totals and the public banner wall update from confirmed records, not merely from arrival or a saved banner.

The agent-service contract upgrade is finalized on Devnet, and its deployed binary matches the validated build; see the [deployment receipt](deployment/deployment.community.devnet.json). The [personal-agent chain report](deployment/personal-agent.chain.validation.json) passed 36 checks and independently verified all nine finalized records of the hosted watcher acceptance journey, including zero-award agent start/return, the human 25-point / 10-reputation allocation, and one free banner. Your new trial has its own publication status: a record can still be pending or awaiting retry, and only its finalized receipt establishes chain publication. The application handoff remains usable while publication completes.

When finished, stop any remaining watcher with Ctrl+C and delete the private downloaded connection file. A later trial requires a fresh approved handoff and connection.

## Send useful feedback

Report the step number, whether you were the rider or guardian, what you clicked, what you expected, what happened, and the approximate local time. Include the visible status/error code and, if helpful, a screenshot with private conversation and location details hidden. Note your browser and whether the terminal stayed open. Do not share the connection JSON, session tokens, API keys, recovery codes, wallet keys or Codex authentication files.
