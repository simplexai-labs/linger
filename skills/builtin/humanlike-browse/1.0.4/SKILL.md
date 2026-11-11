---
name: humanlike-browse
description: Read, survey, post to or manage a site that watches for automated browsing, such as a social network, a marketplace or any site where the user is signed in, through the computer tools in the Computer's own browser. Use whenever a task reads posts, comments, profiles or search results on such a site, or writes there for the user.
---

# Sites that watch for automated browsing

## Choose the route

- A public page that needs no sign-in and no clicks: read it with the web search or fetch tools.
- Anything else on a social network, a marketplace or a site where the user is signed in: only the computer tools, in the Computer's own browser: `launch_app({agent_browser: true, urls: [url]})`. The Computer picks the installed browser (Chrome, Edge, Firefox, or a window of the user's Safari); pass `bundle_id` only when the user asks for one. The browser tools drive a browser in a way these sites detect, so the Computer keeps them off every site the task opened in its own browser; other sites in the same task may still use them.
- If `launch_app` has no `agent_browser`, this needs a Mac Computer: tell the user and stop.
- If a call says a computer tool does not exist, take the tool's exact name from your tool list and call it again before telling the user the tools are unavailable.
- This holds when the user says they are signed in: their sign-in for such a site is kept in the Computer's own browser. Never connect the user's everyday browser for it.
- If the site asks to sign in, ask the user to sign in once in that browser window and stop; the sign-in stays for later tasks.

## Move like a person

These sites watch how a visitor moves, and the user may watch the window. Every page change looks like a person's.

- Open each site once with `launch_app`, at its home page, such as `https://www.reddit.com/`. A page the user names or describes, such as a forum, a category, a search or their order list, is reached from the home page through the site's own controls. Never call `launch_app` again for another page of a site already open.
- After that, reach each page the way a person does: type into the site's own search box, use its menus, filters, sort controls and page links, and click the item you want.
- Never type or paste an address into the browser's address bar, and never build a search, filter or page address yourself, in a tool call or in a script.
- If the page the user wants cannot be reached from the home page, such as a private share link, tell the user and stop.
- Go back with the page's own back link or with the `cmd+[` hotkey to the window. If the item opened in a new tab, close that tab with its Close button instead.
- To see more items in a list that grows as it scrolls, scroll the list with `scroll`. Use the site's next-page link for a paged list.

## Keep it quick

The user watches the window, and each turn of yours costs seconds. The Computer already spaces each input like a quick person. Do not add waits of your own.

- Browse in this conversation yourself. Do not hand the browsing to a background Task: starting one adds a minute, and the user watches this Room.
- Put each page visit in one `run_script`: search, wait, read what you need, open the item, wait, read it, go back. Return to the model only to choose something, such as which items to open.
- Fill a search box with `setValue`, then press Return on that box: it is instant. Use `typeText` only where the box ignores `setValue`.
- After a click or a key that loads something, wait with `app.waitFor` for what the next page shows, such as a heading or a button, with `timeout_ms` about 8000. Never wait with `cua.sleep`; one sleep lasts at most 1.5 s there.
- Read only what you need: `app.query({role, name})`, `getState({query})` or `get_window_state` with `query`. Read the whole tree only to find your way on a page you have not seen.

A visit to a result, in one script:

```js
const app = await cua.getApp({pid, windowId});
await app.setValue({role: "AXTextField", name: "Search"}, "camping kettle");
await app.pressKey("return", {role: "AXTextField", name: "Search"});
await app.waitFor({role: "AXLink", name: "Next", timeout_ms: 8000});
const links = await app.query({role: "AXLink"});
const first = links.find((l) => /kettle/i.test(l.label));
await app.click({role: "AXLink", name: first.label});
await app.waitFor({text: "out of 5 stars", timeout_ms: 8000});
const page = await app.getState({query: "out of 5 stars"});
await app.hotkey(["cmd", "["]);
return {title: first.label, rating: page.tree_markdown};
```

## Read

- Read with `get_window_state`. It returns the whole page the browser has loaded, including the part below the window, so text already on the page needs no scrolling. Pass `query` to narrow a long page. If a read says it was cut, read again narrower instead of guessing.
- Text inside pictures: `recognize_text`; in a picture viewer, `pages` with `next_key`.
- A state the tree does not show, such as liked or followed: look with `include_screenshot: true`.
- To repeat a flow over items, use `run_script`. A script there sends at most 20 inputs: return what it extracted, look at the window, then continue. Many sites open a result in a new tab; the script then reads that tab, so read the tab in front before the next step.
- Stop scrolling when two reads add no new items. Read only what the task needs: one search per keyword, and never reopen an item already read.
- Act only in the tabs this task opened. A click that opens a new tab is the task's tab. Close each item's tab with its tab's Close button after reading it, and the task's last tab when done. If a tab the task did not open is in front, stop and tell the user.

## Write

Write only when the user asked for that action in this task: publish, comment, like, follow or delete. Text to review or a request to draft is not permission.

1. Check on the page that the signed-in account is the one the user meant. If not, stop and tell the user.
2. Make sure exactly one item matches the target. If several do, ask.
3. Send once, then read the page again and confirm the result shows, such as the comment under that account.
4. If the result is unclear, read the page. Never send again blind.

If the user takes over the window, read the page and the account again before the next input.

## Checks and limits

- When a page shows a captcha, a code or QR check, a sign-in wall or a too-many-requests message, call `report_blocker` with that kind and the page's URL at once. Then tell the user in the Room what the page asks for and that they can deal with it in that browser window, report what was done, and end the task.
- When only one item cannot be viewed, call `report_blocker` with `content_unavailable` and its URL, and skip it.
- Never pass a check yourself, switch accounts or retry around a limit.
- When the Computer refuses input with `COMPUTER_INPUT_BUDGET`, `COMPUTER_SITE_COOLDOWN`, `COMPUTER_SITE_BLOCKED` or `COMPUTER_TAB_CHANGED`, report what was done and end the task.
