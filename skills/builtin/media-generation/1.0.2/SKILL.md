---
name: media-generation
description: Generate images and videos with the user's connected fal or Higgsfield account through teamhub image-gen and teamhub video-gen. Let the user choose the provider and model before the first generation, start the job, check it later without blocking, and deliver the saved file. Use when the user asks you to create, draw, render or animate an image or video, including before you delegate one to a Task. Not for plain crops, resizes or format conversions of an existing file, and not for audio or 3D.
---

# Image and video generation

`teamhub image-gen` and `teamhub video-gen` run generation on the user's own connected fal or Higgsfield account and spend its balance. When one of them is connected, generate through these commands. Do not substitute a Runtime's built-in image tool, and never fake a video by panning or zooming a still image locally. Plain crops, resizes and conversions of an existing file stay local work.

Both commands take the same flags; `--help` is offline and grants no permission. Add `--json` and read the fields named below.

## 1. Account

Run `teamhub apps list --json`. Connected App keys are `fal_ai` for fal and `higgsfield` for Higgsfield. To connect one, run `teamhub apps connect fal_ai` or `teamhub apps connect higgsfield`. It posts an authorization card in this chat; continue once the user completes it. When this deployment has no Composio API key yet, the first card asks for that key instead; once the user saves it, run `teamhub apps connect` again for the provider's own card. Connect only a provider the user named or chose in step 3.

## 2. Models and prices

```bash
teamhub image-gen --provider fal --price --json
teamhub video-gen --provider higgsfield --price --model kling3_0 --json
```

- Without `--model`, `--price` lists models of that output type; continue with `--cursor <nextCursor>` while `hasMore` is true. fal rows carry `price` (unit price, unit, currency). Higgsfield returns `pricingStatus: unavailable`: its credit cost is not queryable here, so do not invent one.
- With `--model`, it also returns the model's parameters: fal `inputs` are input fields such as `image_url`, Higgsfield `medias` are reference roles such as `start_image`, plus durations and aspect ratios. Read them before setting anything.

## 3. Let the user choose the path

The provider and model are the user's choice. Use them without asking when the user named them in this request, chose them earlier in this conversation, or holds a lasting preference for them: check `<user-memory>` when it is in your instructions, and your Agent Memory (its summary, and its `MEMORY.md` when the summary mentions image or video generation). Follow a remembered preference only when its provider is connected and its model fits the request, and say in your first message which provider and model you are using, so the user can change them. An explicit request in the current conversation wins over memory.

Otherwise, before the first generation in this conversation, ask with one `teamhub message ask-user` card holding one question:

- Read the whole model list of each connected provider first: do not cut the `--price` output short with `head` or similar, and follow `nextCursor` while `hasMore` is true.
- Offer two to four recommended paths that fit the request, across the connected providers, each naming the provider, the model and, for fal, its unit price; mark a Higgsfield path as billed in credits. A fal model whose price comes back as `unit: "units"` has no readable unit price: it can still be recommended, marked as billed by fal at a price not shown here. Ask even when only one provider is connected, so the user picks its model. When only one is connected, you may add an option to connect the other; when none is connected, ask which provider to connect.
- The user must see every choice, not only your picks. In the question text, after the recommendations, name the other models that fit this output type, grouped by provider, and say the user can name any of them, or ask you to compare more, in their own answer.
- Then end your turn. Do not guess the answer and do not start a trial generation. Once the user answers, use that path for every later generation in this conversation unless they ask for another. Do not claim the choice has been saved.
- Settle the path before you delegate generation to a Task, and write the chosen provider, model and key parameters into the Task.

In a Task you cannot ask. Follow the path the Task names, or one the user stated or holds as a lasting preference as above. If none is settled, do not choose one and do not generate: end the Task with a final reply that says the user must choose a path and lists the paths and prices you found, so the conversation that delegated it can ask the user and start a new Task.

Before a video or a batch of several images, tell the user the model and, for fal, its unit price, unless they just chose it from a card that showed the price.

## 4. Start the job

```bash
teamhub image-gen --provider <provider> --model <model> --prompt "a red fox in snow" --set image_size=landscape_16_9 --output ./playground/<scope-id>/fox.png --json
teamhub video-gen --provider <provider> --model <model> --prompt "camera slowly orbits the bottle" --file start_image=./playground/<scope-id>/bottle.png --set duration=5 --output ./playground/<scope-id>/orbit.mp4 --json
```

- `--set field=value` passes one model parameter; JSON values keep their types. Use only parameters the model returned in step 2. `--file field=local-path` uploads a local reference under a fal input field or Higgsfield media role; repeat it for array fields. Pass an existing HTTPS reference with `--set` instead.
- `--output` names a new file (or a new directory for several results). Nothing is written yet; the path is reused when the job is checked.
- The command returns as soon as the provider accepts the job: fal gives `requestId`, Higgsfield gives `jobs[].jobId`, and both give `nextCommand`. Keep `nextCommand` exactly as returned; it selects the same account, model and output.
- Higgsfield may return `unlimitedChoice` with `jobs: []`: nothing started. Ask the user whether to spend unlimited generations or credits, then rerun with `--set use_unlim=true` or `--set use_unlim=false`. `rejected` means Higgsfield refused the job (for example, not enough credits); tell the user its reason.

## 5. Check without blocking

Tell the user in one short message that the image or video is being generated. Then run `nextCommand` to check the job once:

- An image usually takes 10-60 seconds: check about 20 seconds after starting. A video usually takes several minutes: check about a minute after starting, then every minute or two.
- Between checks, finish other pending work; use a short `sleep` only when nothing else is left. Run each check yourself; do not wrap the CLI in a polling script.
- Both providers report `status` as `queued`, `running`, `completed` or `failed`. A job that is `queued` or `running` returns `nextCommand` again; use the newest one.
- When every job has ended, the check saves the results to `--output` and returns `files` with paths; missing folders in that path are created. A `failed` job has no file and its `error` says why, such as a safety or copyright block: tell the user and ask before paying for another attempt.
- If a video is still running after about 15 minutes (an image after about 5), tell the user it is still in progress and keep the job ID, so you can check again when they ask.

## 6. Deliver

Attach the saved file to a message:

```bash
teamhub message send --content "Here is the fox illustration." --attach ./playground/<scope-id>/fox.png --json
```

In a Task you do not send messages: leave the file under `./playground/<task-id>/` and name it in your final reply. If a saved file has a `warning` about its extension, rename it to the extension the warning names before attaching it.

## Failures

- `outcome_unknown` after a submission means a paid job may have started. Never rerun the generation. Read `issues` for the provider's reason and continue with the `nextCommand` in `partial_receipts`.
- A `--job` check never submits or charges, so a failed check can be run again once its cause is fixed, for example with a new `--output` path.
- `file_transfer_failed` keeps the files already saved. Run the job check again with a new `--output` path; it does not submit or charge again.
- A provider error about too many concurrent jobs (Higgsfield's starter plan allows two) means start the next job after an earlier one ends.
- A denied permission review means the user declined this spend. Do not retry through the other provider or a built-in tool to get around it.
