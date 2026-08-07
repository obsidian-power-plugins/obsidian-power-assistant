# Changelog

All notable changes to Power Assistant (formerly Power Capture). Dates are when the version was cut.

## 1.92.4

### Changed

- The README is about half its old length and written for someone reading it for the first time. The reasoning behind each decision is kept only where it changes what you would actually do.
- It now lists the other Power plugins, with a line each and a link, and says plainly that every one of them works on its own.
- The Buy Me a Coffee button moved to the foot of the page, under Support, instead of sitting under the title before the plugin has been described.

## 1.92.2

### Fixed

- **Capture a YouTube video has its icon back.** The row sat blank in the launcher and beside the command anywhere else it appears. Obsidian 1.13 dropped the brand icons it used to carry, `youtube` among eighteen of them, and an icon Obsidian does not have draws an empty slot rather than complaining, so nothing said why. The command now uses `square-play`, which is the same silhouette without the mark.
- **The check that is supposed to catch exactly that was looking at the wrong Obsidian.** It read the copy under Program Files, but Obsidian updates itself without touching the installer: it downloads a new version into your config folder and runs that instead. So the check was passing against 1.12.7 while the icon was missing on the 1.13.4 that was actually running. It now reads the newest downloaded version and falls back to the installer, and it catches this on its own.

### Fixed

- **A picture's size is the stylesheet's to describe again.** Dragging a captured post's picture wrote the released height cap straight onto the element, which meant a theme had no say in what a sized picture looks like, and the reviewers' own checks say so. The cap now lifts through a class, so the rule lives in `styles.css` where it can be read and overridden.
- **A frontmatter property that is a list or a map no longer reads as `[object Object]`.** Frontmatter is whatever the note says, so a date, a location, or a vendor can arrive as something other than the single value it looks like. Every reader of one now treats anything that is not a single value as nothing at all, rather than writing that placeholder into a briefing or a digest. A date property that arrives already parsed now yields the day it names, where it used to yield `Wed Jul 15 2026` and get sliced into nonsense.

### Internal

- The lockfile a fresh checkout installs from now carries every dependency the build needs, which is what the community submission checks first. Without it the install stops, nothing else can be checked, and the whole source read comes back as noise about types it could not resolve.

### Changed

- **A post's video is no longer transcribed when the post already says what it means in words.** This file has always said that a post is its words and the audio is a bonus, and the capture now behaves that way. Transcribing costs a download and an API call, and on a post with a caption it routinely buys nothing: the audio under a meme is music, and the transcript comes back empty. A wordless video post is still transcribed, because its audio is the only thing there to capture. The old behaviour is **Transcribe a post's video → Always** on the Capture tab, which is worth choosing if you capture talking-head clips whose captions say little; **Never** skips the download too.
- A transcription key is now only demanded when a capture is actually going to transcribe something. It used to be required to capture any post carrying video, including ones whose audio was never going to be read.

### Faster

- **One yt-dlp run instead of two.** Describing a post and downloading its audio were separate calls, and each paid the whole cost of starting the program: on a machine where the launcher is not on PATH, that is Python's startup twice. Measured on a ten-second post, the pair took 3.1 seconds and the single run takes 1.8.
- **The work that does not depend on other work now runs alongside it.** X's own read of a post goes out with the yt-dlp call rather than after it, and the pictures download while the audio is being transcribed, instead of waiting for it to finish.
- The way of invoking yt-dlp that worked is remembered for the next call, so a machine where the launcher is off PATH stops paying for a failed start every time.

## 1.91.0

### Added

- **A captured clip can be turned into an animated GIF**, from the right-click menu on the picture or the command palette. The GIF is written beside the note and shown in your file manager, ready to copy: one Ctrl+C there and Ctrl+V into Teams or a mail client lands a moving picture. Revealed rather than copied because the clipboard cannot hold one — Chromium writes `image/png` and nothing else, so anything placed on it directly arrives as a single frozen frame, and a GIF *file* is what chat and mail clients actually animate.
- The numbers behind it were measured rather than guessed, on a ten-second clip: 360 pixels wide, 10 frames a second, 128 colours, which comes to about 5.6 MB and three seconds of work. Full colour at 480 and 12 a second produced 13 MB of the same clip, which is not something to paste into a chat window. A clip too long for the frame budget drops its frame rate rather than being cut short, since the point of a meme is usually its last second, and the GIF is written to loop.
- Note that classic Outlook on the desktop shows only the first frame of an animated GIF in a message it is composing. Teams, and Outlook on the web, animate it.

## 1.90.0

### Added

- **A captured post keeps its pictures.** A post is frequently nothing but a picture, a chart, or a clip, and until now a capture kept the words around one and threw the thing itself away: the video went to yt-dlp for its audio, was transcribed, and was deleted. What was left was a note about something it could not show. Photos, GIFs and video are now saved into your attachments folder and embedded under a Media heading at the top of the note, above the post's own words and the notes extracted from them. A copy rather than a link, because posts get deleted and addresses expire, and a linked picture leaves a broken image where the captured thing used to be; the copy also works offline and on a phone. A GIF is kept as the MP4 that X converted it into, so it still moves. X is asked for its own media, which is the only way to tell a GIF from a video and to get photos at full size; every other site yt-dlp handles contributes the still it reports.
- **A captured clip plays on open, loops, and stays silent**, which is what it did on the site. X serves an uploaded GIF as an MP4 and files most short meme clips as videos too, so embedding one the ordinary way would put a still with a play button where the post had something moving. The controls are still there, so it can be paused or unmuted, and anything over a minute is left alone: a video that long is meant to be watched, not glanced at, and looping it on every note open would be a nuisance rather than a likeness of the post.
- The post's own words now come from X's read of the post rather than yt-dlp's description of it, so the `t.co` link X appends for its own media no longer trails the text, and a quote-post carries the post it is quoting.
- **A captured picture has a corner to drag.** Obsidian resizes an image embed by dragging and writes the result into the link as `|400`, and does nothing of the kind for a video, which is what a captured clip is. There is now a grip on the bottom-right corner of a captured picture, faint until hovered rather than appearing only on hover, because a control nobody can find is a control that does not exist. Dragging it writes the same notation Obsidian does, so the size means what it would mean anywhere else in the vault and the note stays an ordinary note. A width set that way beats the height in settings, since it is the more specific answer and the one the note was given on purpose; double-click the corner to clear it and hand the picture back to the setting.
- Three settings on the Capture tab: **Save the post's pictures** (on); **Largest item to save** (25 MB), so one long video cannot quietly add hundreds of megabytes to a synced vault, with anything over the limit keeping its poster frame so the note still has a picture in it; and **Picture height in the note** (360 px), the starting size for every captured picture, because a post's video is often taller than the screen and filling the note with it leaves a note that is all picture. The cap is a height rather than a width, since posts come in every shape and only a height keeps a portrait clip and a landscape one both to a readable size; the shape is always preserved, the file is untouched, and changing the number re-sizes every capture you have not dragged, straight away.

### Fixed

- **A wordless post no longer files a bare link as its content.** X appends a `t.co` link to the text of every post carrying media, so a post that is all picture arrives looking like a one-line post whose line is that link. The capture had a reader for exactly this, and the last check before writing the note asked a different question, so the shortener went into the note under `## Post` where the post's words belong.
- **A note with nothing to summarize no longer blames a missing API key.** Extraction is correctly skipped when a post has no words in it, but the note said "configure an Anthropic API key", sending a reader whose key is fine off to fix something that was not broken.
- **The sticky player no longer claims a post's own clip.** It takes the first audio-or-video file a capture note embeds, which used to mean the recording and now could mean the post's picture: the transport bar mounted over a GIF, the stylesheet hid the embed behind it, and the note showed a Media heading with nothing under it and a scrubber that played silence. The player, the frame grab, and the stamp seeks all skip the Media section now.
- **A re-extract no longer duplicates itself on a note that leads with a picture.** Finding where a note's extracted sections end treats a line beginning with an embed as the trailing recording players, which a post's media at the top of the note is not. Rewriting one would have written the new summary above the picture and left the old one below it.

## 1.89.13

### Security

- **A link has to be a link before it can become an argument to yt-dlp.** yt-dlp reads a word beginning with a dash as an option wherever it appears in its arguments, and its options include ones that run commands, so a "URL" of `--exec=...` would have been obeyed rather than fetched. Nothing could reach it that way: every capture goes through `ensureUrlScheme`, and refreshing a note's stats requires its `source` property to already start with `http`. But that safety sat several calls above the one line that starts a program, resting on two functions that have other jobs, and a reasonable change to either would have quietly removed it. The check now lives in the argument builders themselves, where the URL is still an ordinary string: an `http` or `https` scheme, or the capture stops with an error. Real links are unaffected, dashes inside a URL included.
- `shell: false` is now passed explicitly when yt-dlp is started. It was already the default, and the difference between running a program and handing a string to a command interpreter should not have to be read out of an absence.

### Changed

- The README lists what the community catalog's scan reports about this plugin, what each one is actually for, and where in the source to check it: starting yt-dlp, listing vault files, reading and writing the clipboard, and the temporary files written outside the vault.
- **The stylesheet no longer asks `:has()` questions the code can answer as it draws.** Four of them stood over the whole note for the life of the session: whether a turn held a highlight, whether a blank line sat above a speaker, whether an embed held audio, whether a stamp followed the title. Each is now a class set at the moment the answer changes, which is also what the community catalog asks plugins to do. The settings page does the same for the rows that span both columns, in place of eight more. Nothing looks different.
- The three Node modules this reaches for on desktop (the filesystem, yt-dlp's launcher, and the temp directory) are imported once at startup behind the platform check rather than required where they are used, and the TypeScript config names the node types, so the whole of that code is type-checked rather than passing through as `any`.

## 1.89.12

### Fixed

- **A capture no longer opens a second copy of a note you already had open.** Finishing a capture into an open note handed you a duplicate of it: two scroll positions, two undo histories, and edits landing in whichever one you looked at last. That is worse here than it would be elsewhere, because a meeting note is usually open precisely because you were typing in it while the recording ran, and the copy that came back was the one that covered it over. Every route that opens a note which already existed now steps to the tab already holding it: the transcript handed over for tagging, a merge into an existing note, a regenerated note, and a recording stub another device may already have finished. Citations in the assistant panel do the same, since a citation usually points at the note you are already reading. Ctrl or Cmd still asks for a new tab and still gets one. Only tabs in the main area count, so a note in a sidebar or popped out into its own window is never yanked into focus behind your back.
- **The merge into an existing note stopped opening a duplicate on its way past.** Since Obsidian 1.7.2 every tab you are not standing in is deferred, holding a stand-in that reports no file, so the search for an already-open copy missed it and opened another.
- **The live transcript hears the whole mix again, not just its left half.** When a recording captures system audio, the mic and the desktop meet as a stereo mix, and the tap rebuilt in 1.89.11 was reading the left channel alone. Anything sitting on the right by itself stopped reaching AssemblyAI. The transcript still streamed throughout, which is why nothing looked wrong. The tap is explicitly mono again, the way the node it replaced behaved. Mic-only sessions were unaffected, as were the saved recording and batch transcription, which never went through this tap.

## 1.89.11

### Changed

- **The live transcript is fed from an AudioWorklet.** It ran on a `ScriptProcessorNode`, deprecated for years, which does its work on the main thread: a render, a vault write, or a long extraction could stall it and drop samples out of the stream. The worklet runs on the audio thread, where this work always belonged, so a busy Obsidian no longer costs you words. A tap that cannot start now says so and leaves the recording alone, rather than quietly taking it down with it.

## 1.89.10

### Changed

- **Settings turn up in Obsidian's own settings search.** Obsidian 1.13 builds a settings tab from the definitions a plugin declares and no longer calls the older `display()`, and a tab that only implements the old way keeps working but has none of its settings indexed, which is the part you notice when you go looking for one. Both renderers now draw from a single declaration of each row, so they cannot drift apart. On 1.13 and up you get a native page per tab and a headed group per section; older builds fall through to the previous tab exactly as before, folding and two-column layout included. The minimum Obsidian version is unchanged at 1.8.7.
- Ten rows on the Meetings tab were sitting under the **Voice identity** heading only because no new section began after it. Action items and recording length are back under Meetings, where they belong.

## 1.89.9

### Changed

- **Documents are read by Power Extract now, with Text Extractor kept as a fallback.** Processing a receipt or a bill starts by reading the text off it, and until now that reading was done by the Text Extractor community plugin, which has not been updated in seven months and downloads its OCR engine and language data from a CDN the first time it runs. Power Extract uses the recognizer already built into Windows instead: nothing is downloaded, no image leaves the machine, and on a sample of 80 images from a real vault it read 39,435 characters against 25,364, with a far higher share of it being actual words. A vault that still has Text Extractor and not Power Extract keeps working exactly as before, because both are tried in turn. PDFs are unaffected: their text has always been read by Obsidian's own bundled pdf.js and needs no companion plugin at all.

## 1.89.1

### Fixed

- **A long recording is no longer abandoned mid-write.** Reading and writing a recording's audio were both allowed a flat ten seconds, which covers a two-minute voice memo and comes nowhere near a three-hour meeting: a 60 MB file written into a vault that lives inside a synced folder needs far longer, so a perfectly healthy write was called failed while its bytes were still landing, and the capture was reported lost. Losing that race did not stop the write either, so Obsidian carried on and left a part-written recording in the vault, which is exactly the shape a vault syncer picks up and uploads as though it were the whole file. The budget now scales with the size (thirty seconds at minimum, three more per megabyte, so 60 MB gets three minutes), the write is followed to its end rather than left running, and a fragment is cleared if it never finishes. Applies to the blob read, the recording write, and the crash-recovery write, which was on the same flat ten seconds.

## 1.89.0

### Added

- **A button that brings a post's counts up to date.** A capture is a snapshot: the views and likes in its properties are the numbers the post had the moment it was filed, and a post that is still circulating leaves them behind within the hour. A refresh icon now sits in the header of any captured post or video, next to the note's other actions; one click re-reads the source and writes down whatever moved. The same thing is on the note's right-click menu and in the command palette as **Refresh this post's counts**, so it can take a hotkey. It appears only where there is something to refresh, which is a captured post or video and not a web page or a recorded meeting. Obsidian's properties panel is closed to plugins, so the button cannot sit directly beside the numbers it updates; the note header is as close as one can get without writing a widget into the note itself.
- Only views, likes and replies are touched. Everything else a capture holds describes a post that has already been posted, and re-reading must not disturb any of it: not the title, not the post's own words, not the notes extracted from them. A count the fresh read cannot see is left alone rather than blanked, so a post with no video, whose counts come from X's embed payload instead of yt-dlp, keeps the view count it already had.

### Fixed

- **A post captured through yt-dlp records its reply count.** yt-dlp calls it the comment count and the plugin was not reading it, so the same post filed with a video had no `replies` property while one filed without a video did. Both now record it, and refreshing a note written before this fills the property in.
- **The mail window keeps both hands on the same clock.** Moving every date onto the local clock swept up one that has to stay in Greenwich. The rolling index of recent mail places each message by the date Microsoft stamped on it, which is UTC, and then measures the horizon from today, so if today is read locally the two sides fall a day apart every evening west of Greenwich, and a day's mail that should have aged out stays in the index. It is the one date in the plugin that is not yours, because it is not about a day you named; it now says so where it is written, and the tests say what would go wrong if it changed back.
- **The MCP server stops calling tomorrow's bill overdue.** 1.88.0 moved every date the plugin writes onto the local clock and missed one reader: the standalone MCP server in `mcp/`, which is not part of the plugin bundle and was not swept up with it. Its `finances_summary` decided which bills are late by comparing their due dates (dates the plugin wrote off your own calendar) against the day in Greenwich, so from the early evening onward a bill due tomorrow was reported to Claude as already overdue. It reads the local day now, from its own copy of `dayOf`, having no build step to import the plugin's through.

## 1.88.0

### Added

- **A fresh install says it needs setting up, once.** Nothing here transcribes or extracts without a transcription provider or an AI model, and an install with neither gave no sign of it until the first capture failed, which teaches the same lesson at the worst possible moment, since by then the meeting has already happened. A new install now says so at load, with a link straight to the setup tab. Said once and never again: the notice records that it has been shown, and an install that has either a provider or a model never sees it.
- **The ribbon icons can be turned off.** Four icons on a strip shared with every other plugin is a lot to claim, and not everyone wants all of them. Each can now be switched off under Ribbon icons in settings: the microphone, the calendar, the sunrise, the sparkles. Turning one off hides only the icon, its command still works, so nothing becomes unreachable. The strip updates as you flip each toggle rather than at the next reload.

### Fixed

- **A post that is all video no longer becomes a note about nothing.** X appends a link to its own media to the end of every post carrying a photo or video, so a post with no words of its own arrives looking like a one-line post whose line is a link. Capture read the link as the post's text, sent it off to be summarized, and filed the model's reply (that it cannot summarize a URL) under the heading where the summary belongs. Those links are now recognized for what they are (in both spellings: the real `t.co` address the embed reports, and the `pic.x.com` display form oEmbed renders), and a post left with no words is treated as having none. Nothing to summarize now means nothing is asked, so a refusal can no longer land in a note. The same reading applies to a quoted or replied-to post, which used to be able to contribute a bare link as context.
- **And it says which program would have captured it.** A wordless video post is not an empty post: its words are in its audio, and yt-dlp is what fetches audio. Capture now says that, names yt-dlp, and stops, rather than writing a note that will have to be deleted. When yt-dlp is installed, that post captures the way it always should have. The check happens before a folder or a filename is worked out, so the message is about the post rather than about a note that does not exist.
- **Evenings stop being filed under tomorrow.** Every date the plugin wrote was the date in Greenwich, so from early evening onward (seven at night in New York, nine in Chicago, five on the west coast) a note named itself for a day that had not started yet. A meeting recorded on Saturday night was called Sunday's, sorted ahead of Sunday morning, and sat outside the week that was supposed to contain it; the same hour shifted `date` in the properties, the weekly digest's span, the morning briefing's horizon, the seven-day windows behind "recently", and the timestamp on a recording's filename. All of them now read the day off the local clock. The relative ones count days along the calendar instead of subtracting twenty-four hours at a time, so the two mornings a year the clocks move no longer push a boundary onto the wrong date. The one place still working in UTC is the calendar fetch, which hands Microsoft an exact moment rather than a day, and is right to. Notes written before this are unchanged: a note dated a day ahead keeps the date it was given, since only you know which of them were late nights.

### Changed

- **Em dashes out of the notices.** A handful of user-facing messages set their clauses apart with an em dash where a colon says the same thing more plainly.

## 1.87.1

### Changed

- **The part offsets stop showing themselves.** A rotated recording carries where each part starts, so every `[m:ss]` link in its transcript can open the right file at the right place (real work, and `[0, 3900876]` in a properties panel is still noise wearing the clothes of information. The key moved to `pa-parts`, beside `pa-recordings` and `pa-eval` where the plugin's other machine-only keys live, and that one key is hidden from the properties panel. Hidden, not removed: the stamps still read it and it is still in the file. Notes written before the rename still say `parts` and still work. Scoping the rule to the prefixed key matters) a plugin should hide what it wrote, not a property someone else uses.

## 1.87.0

### Changed

- **Two properties fewer on a recorded meeting.** `source` repeated the path of a recording the player under the transcript already names, links and plays, three references to one file. It goes when there is a player, and stays when there is not: a recording set to be trashed after processing leaves the path as the only record of what was transcribed. `speakers` counted the voices and nothing read it; the **Speakers:** line under the title already says who spoke and how much, which is the useful form of the same fact.

## 1.86.0

### Added

- **Keep the meeting template as a note.** If you already keep templates as notes, point **Meeting template note** at one and its body becomes what a new meeting note starts with, written in the editor with live preview, synced with the vault, its history your vault's history. The magnifier picks one without typing a path. Its own properties are ignored: they describe the template, not the meeting, and the plugin writes the meeting's own. Tokens this plugin does not recognize pass through untouched, so a template shared with another tool keeps that tool's placeholders. A note that is later renamed or deleted says so once and falls back to the settings box, rather than failing the note you were trying to create.

### Fixed

- **The template box is big enough to write in.** It was squeezed into the narrow control column on the right of the settings row, about eight characters wide, which is no way to edit a document. It now takes the full width under its own description, in a monospace face, and can be dragged taller.

## 1.85.1

### Changed

- **A new meeting note starts with a checkbox.** The default template gained a **Follow-ups** section holding one empty `- [ ] `, between the notes and the agenda, so there is somewhere to put a commitment the moment it is made rather than after the fact. If you had not edited the template, yours moves to the new default on load; if you had, it is left exactly as you wrote it, an edited template is never overwritten.

## 1.85.0

### Added

- **The meeting note is a template you can edit.** What a new meeting note starts with was written into the plugin; it is a setting now, under Meetings. Arrange it how you like, with `{{title}}`, `{{date}}`, `{{agenda}}`, `{{when}}`, `{{where}}`, `{{join}}`, `{{meetingId}}`, `{{passcode}}`, `{{attendees}}` and `{{series}}` filled in from the invite.

  A line that carries tokens and gets nothing back is left out, label and all, so `**Where:** {{where}}` leaves no orphan "Where:" on a meeting with no location. A line with no tokens is kept exactly as written, so your headings and checklists come through untouched. The arrow button puts the default back.

  The properties above the body are still the plugin's own and are not templated: they are structured fields Obsidian edits in place, and one malformed line would break a note's YAML.

## 1.84.0

### Changed

- **A meeting note opens on somewhere to write.** It used to open with its own title and a When/Where block, which said what the filename and the properties directly above them already said, so the note began by repeating itself and the first useful line sat a screen down. That block is gone. In its place is a **Notes** heading with a bullet ready to type into, and the agenda under it. The join details were the one part of that block not already carried elsewhere, so they moved up into the properties: `join` holds the URL (Obsidian links it), with `meeting id` and `passcode` beside it.

  Notes written during a meeting sit above the AI summary after the recording is folded in, exactly as the agenda always has.

## 1.83.0

### Changed

- **A video's length is written to be read.** `2:03:13` makes you count the colons to learn it is a two-hour podcast. Lengths now read `2 hr 3 min`, `43 min`, `31 sec`, on captured videos and social posts alike. Seconds are dropped once there are minutes to report. The transcript's own `[m:ss]` stamps are a different thing and are unchanged.
- **No blank line between the properties and the note.** A capture whose filename already carries its title writes no heading, and the gap where that heading used to be stayed behind, so every such note opened with an empty line before its first section. The first heading now sits tight against the properties block, exactly where the title used to.

## 1.82.0

### Fixed

- **A video captured past the wall keeps its properties.** When YouTube refuses to describe a video, the page reader comes back with almost nothing, so a capture that got through on yt-dlp's second opinion still landed with only a channel URL and a subscriber count where the other YouTube notes carry the channel, the date, the views and the length. yt-dlp is now asked for all of that in the same run it fetches the subtitles, and it fills whatever the page could not answer. The page still wins wherever it did answer.
- **The sign-in button no longer contradicts the row beside it.** With a session saved it said "Sign in", which reads as though the sign-in had not worked; it says **Open YouTube** now, and the **Test** button that says whether captures actually get through sits on that row rather than three settings further down.

## 1.81.0

### Changed

- **A saved YouTube session is used, whatever its cookies are called.** Signing in through the TV pairing left a working session (the window came back showing the account, its recommendations and all) and the plugin refused to use it, because none of its 19 cookies were named what the sign-in check expected. That check now decides nothing: any session the sign-in window leaves behind is handed to yt-dlp, and whether it works is answered by YouTube rather than by a list of cookie names in here. The settings row says how many cookies are saved instead of claiming a verdict it cannot reach, and **Test YouTube** beside it is the thing that actually answers.

## 1.80.2

### Fixed

- **A signed-in session is recognized as one.** Pairing a code signed the window in properly and the settings row still said "Not signed in", because the check was asking the session for cookies on two named domains and looking for four cookie names. A sign-in is not one cookie: which names it uses and where they land depend on how it was done, and a session paired from a television leaves a different set than a password typed into the website. The whole session is now read and filtered here, across every domain a Google sign-in spreads to, and any of the cookies that carry a sign-in counts. When it still finds none, it says how many cookies it did see and lists their names in the console, so the next answer is a fact rather than a guess.

## 1.80.1

### Fixed

- **Signing in no longer asks Google for something it will not give.** 1.80.0 opened YouTube's ordinary sign-in page, and Google answered "this browser or app may not be secure", it does not accept a password typed into a window hosted by another app, which is a sensible rule and not one worth dodging. Sign in now uses the flow Google built for devices in exactly that position: the window opens YouTube's TV interface, you choose Sign in, and it shows a short code. You approve that code at youtube.com/activate in the browser you already trust, and the window is signed in. No password is ever typed inside Obsidian. There is a button beside Sign in that opens the activate page for you.

## 1.80.0

### Added

- **Sign in to YouTube from inside Obsidian.** YouTube increasingly answers a device it does not recognize with "Sign in to confirm you're not a bot", and being signed in on your browser does not help: a capture goes out from Obsidian and from yt-dlp, and neither can see your browser's cookies. So sign in here instead. **Settings → YouTube sign-in → Sign in** opens YouTube in its own window, you sign in exactly as you would anywhere, and you close it. Captures then go out as you, and the row says whether you are signed in.

  The session lives in this plugin's own store, separate from the rest of Obsidian, and is never written into your vault or into a note. When a capture needs it, it is handed to yt-dlp as a temporary file that is deleted the moment the download finishes. Sign out clears the whole thing.

  The window presents itself as the Chrome it actually is, because Google refuses to sign anyone in from something it can tell is an embedded app. The exported cookies file added in 1.79.0 still works and still takes precedence over the browser-store setting, for anyone who set it up already, but nobody should need it now.

## 1.79.1

### Added

- **A Test YouTube button, beside the cookies settings.** Being signed in to youtube.com in your browser does not reach a capture: it goes out from Obsidian and from yt-dlp, and neither shares the browser's cookie jar, so YouTube sees a stranger no matter how signed in you are. The button asks YouTube for one public video's title using whatever cookies are configured, downloads nothing, and says plainly whether this device can read YouTube right now. The wall also comes and goes, so it doubles as the cheap way to try again.

## 1.79.0

### Fixed

- **"This video has no captions to fetch" was usually a lie.** YouTube now answers an unrecognised device with "Sign in to confirm you're not a bot", and it does so as an ordinary 200 carrying nothing at all: no title, no formats, and an empty caption list that reads exactly like a video without subtitles. The capture reported what it saw, which sent you looking at the video instead of at the wall in front of it. The refusal is now read off the response and said plainly, along with what to do about it.

### Added

- **yt-dlp is a second opinion on a YouTube capture.** When YouTube says a video has no captions, yt-dlp is asked too: it knows more ways to put the question and it can present cookies, and it often gets the subtitles the direct route was refused. It downloads no video, only the subtitle track, and it also brings back the real title, so a capture that got past the wall is still named properly. A video that genuinely has no captions still says so.
- **A cookies file setting.** Cookies get past the sign-in wall, but reading them out of Chrome or Edge fails on Windows because both encrypt their cookie stores. Point this at a cookies.txt exported from your browser and every yt-dlp download uses it, which is the one route that works on such a machine. Keep the file outside your vault: it holds live sessions.

### Changed

- **Automatic captions no longer arrive three times over.** YouTube's speech-recognized tracks are a rolling two-line display, so each cue repeats the line before it; pasted together, the transcript said everything two or three times, which read badly and cost that much again to extract. Overlapping words are now folded together, taking a real 371,000-character track down to the 124,000 characters that were actually said. Where a video offers both a human-written track and an automatic one, the human one is preferred.

## 1.78.1

### Changed

- **A screen has to be nearer the point it illustrates.** The window was half a minute either side of a stamped point, which is wide enough in a real meeting to reach the screen the PREVIOUS point was about, and a decision captioned with the wrong slide is worse than one with no slide at all. Fifteen seconds now. A frame that no longer reaches a point is not lost: it becomes part of the Screens section, the same as any other frame with nothing near it.

## 1.78.0

### Added

- **The screen beside the point it shows.** Screens arrived in 1.77.0 as a section at the foot of the note, which meant reading a summary and then scrolling down to work out which picture went with which point. Turn on **Timestamp each point** and extraction ends every summary, decision, risk and question with the `[m:ss]` it came from; each of those is a click back to that moment in the recording, and a screen found within half a minute of one is placed under it instead of in the gallery. That is a recap that reads the way the meeting went: the decision, then what was on the screen when it was made. Anything with no point near it still becomes the Screens section, so no frame is ever dropped.

  A stamp is only as good as its honesty, so the model is told to leave it off rather than guess: an invented stamp would send both the reader and the screen beside it to the wrong minute. Action items and Keywords never take one, because a Tasks checklist line and a comma-separated keyword line each have a fixed shape a trailing stamp would break.

  One screen per point and one point per screen, nearest pairing first, so two bullets a minute apart cannot both claim the same picture and one bullet cannot collect five.

- **A marked moment is a screen too.** Marking a moment mid-recording is a person saying "this matters", which is better evidence than any measurement of pixels: the screen may not have changed at all when the number everyone was waiting for was finally read out. A scan now grabs a frame at every mark in the note as well as at the changes it found, and marks are not subject to the frame cap, which exists to bound an automatic measure rather than a deliberate one. A mark within a few seconds of a frame already kept is left alone: the same screen twice is not two screens.

- **Screens in the Word recap.** 1.77.0 kept them out of the .docx, because a recap built from prose and tables cannot resolve a vault embed and would have written `![[frame.webp]]` into a formatted document. Now the pictures themselves go in, under the section they belong to, each with its timestamp and whatever the reader found in it as a figure caption. A frame placed beside a point stays with that point's section rather than being collected at the end. Frames are re-encoded from webp to PNG on the way, since Word has only recently learned to read webp and the document format's own image types never have.

### Fixed

- **A screen is no longer mistaken for a decision.** Person pages and the weekly digest quote the Decisions and Questions sections of every meeting, line by line. An illustrated decision has the frame and its caption sitting under it, and both were being read as decisions in their own right, so a person's hub would have listed an image embed among the things that meeting decided. A frame, and the text quoted beneath it, now count as part of the point they illustrate.

- **A capture note is no longer rewritten out from under the editor.** Folding a recording into an open meeting note writes through the editor, where the changes are not yet on disk, and the screens pass that immediately follows would then have read the stale file and written the edited version away. Every path that rewrites a note a capture run has just touched now goes through the same editor-aware write, which is what the in-note progress indicator already did.

## 1.77.0

### Added

- **The screens a meeting was actually about.** A recorded meeting is mostly a shared screen, and the screen is often the point: the architecture page someone walked through, the number on the slide, the design nobody described out loud. Grabbing those one at a time arrived in 1.76.0; now the recording can be walked in one pass. **Add screens from a video file** takes any capture note, scans a recording, and adds a **Screens** section holding a frame from every moment the picture changed, each with the timestamp it came from and each clickable back to that moment.

  It works on a recording that is not in the vault, which is the case it was built for. A Teams recording downloaded next to its transcript is hundreds of megabytes and has no business in a synced vault; choose the file where it sits and only the frames are written in. Pair it with *Import a transcript file* and a Teams meeting lands complete: named speakers and true timestamps from the `.vtt`, the screens from the `.mp4`, and no video in the vault at all.

  What counts as a change is a setting, because meetings differ. Each look is compared with the last frame that counted as a change rather than the one before it, so a slow fade cannot creep past the threshold a pixel at a time and register a new screen every few seconds. When more changes are found than the cap allows, the biggest changes are kept and a notice says how many were left out, because silently keeping twelve of forty reads as "this meeting had twelve screens", which is a different claim. Turning on **Read each screen** has the AI model read every kept frame and quote what it found under the image, which is what makes an architecture page findable later by what it said rather than only by when it appeared.

  Nothing needs installing for any of it. Obsidian already decodes a video in order to play it, so the frames come from that same decoder and not from ffmpeg. The cost is time and space: roughly a minute of background work per hour of recording, and about a megabyte of images per meeting at the default cap. A scan that long has to be stoppable, so the notice reporting progress is the thing that stops it, and stopping writes nothing. Off by default, under a new **Screens** section on the Audio tab; the per-file processor has its own toggle, so it stays off in general and can still be asked for on the recordings where the screen mattered.

### Fixed

- **A capture's screens no longer leak into the places a note leaves the vault.** Two surfaces render a note for somewhere else and would have carried the new section as raw text. The Word recap is prose and tables built from the note's structure and cannot resolve a vault embed, so it would have written `![[frame.webp]]` into a formatted document; it now skips Screens exactly as it skips the transcript and moments. *Copy summary* cut everything from the Moments heading down, and Screens sits above it, so the frames flowed into an email as flattened filenames where the pictures should have been; the cut now starts at whichever of the three comes first. Putting the pictures themselves into a Word recap is a real feature, and a separate one.

## 1.76.0

### Added

- **Grab a frame from the recording, at the moment you are reading about.** A recorded meeting is mostly a shared screen, and the screen is often the point: the architecture page someone walked through, the number on the slide, the design nobody described out loud. The note kept every word of it and none of the picture. Put the cursor on any transcript turn, or on a moment, and **Grab a frame at this stamp** saves that instant of the video into the note just below the line you were on. The frame is written with its own stamp, so it doubles as a jump back to the moment it came from, and it can be grabbed from in turn. Nothing needs installing: Obsidian already decodes the video in order to play it, so the frame is drawn from the same decoder that plays the embed, with no ffmpeg and no second program to find. A rotated recording is handled, since the stamp knows which part it belongs to, and a file that turns out to carry only sound says so instead of writing a blank image. The command appears on a note that actually embeds a video, and nowhere else. It is also on the right-click menu of any stamped line.

### Fixed

- **A stamp click works on a video capture.** Clicking a timestamp in a note whose recording is an mp4 looked for an `<audio>` player, found none, and asked you to open the note in Reading view when you were already in it. Video embeds now count everywhere audio ones do: stamp clicks in Reading view seek them, the editor's fallback seek finds them, and the duration fix that makes a MediaRecorder file report its true length reaches them too, rather than an observer waiting out its timeout for an `<audio>` element that was never going to arrive.


## 1.75.4

### Fixed

- **Person pages stop manufacturing a sync conflict every day.** Two devices each rebuilt the same generated pages from their own view of the vault, so the same data produced different bytes and every rebuild contradicted the other machine's. One vault collected 66 conflict copies in a day, all of them `Meetings/People`, one of them a fresh copy every minute alternating between two versions. Three causes, all now removed. Same-day meetings, commitments, decisions and questions were left in whatever order Obsidian happened to list files in, which is creation order on the device that recorded the meeting and download order on the one that synced it; ties now break on path and text, so every device sorts identically. The `date` in the frontmatter was stamped with today's date, so the page's bytes changed daily whether or not anything in it had; it now comes from the newest item the page actually shows, and a refresh keeps whatever the page already carried. And a note with no date in its frontmatter fell back to the file's creation time, which is a different instant on every machine; a dated filename is consulted first.
- **A rebuild no longer runs against a half-synced vault.** The files Power Connect writes raise the same create and modify events a person typing raises, so an incoming meeting note triggered a rebuild while the rest of the change was still arriving, and this device published a page the other one was about to contradict. Rebuilds now wait for the sync to finish. The device that made the change rebuilds and publishes; the others take the result and, finding nothing to change, write nothing at all.
- **A sync conflict copy is no longer mistaken for a person, or for a second meeting.** A conflict copy of a person page still carries `generated: true`, so the refresh treated its filename as an attendee, found that "George Olney (sync conflict 2026-07-29 1245 ac6be5)" had attended nothing, and overwrote the file with an empty hub. That file is the copy Power Connect had just written to preserve the losing edit, so the safety net was being destroyed by the thing it protects against. Conflict copies are now skipped by the refresh entirely. They are also skipped when tallying meetings: a conflict copy of a meeting note is the same meeting twice, and it exists only on the device that made it, so counting it guaranteed the two machines would disagree.

## 1.75.3

### Fixed

- **A sync conflict copy of a recording is no longer processed a second time.** When a sync client cannot merge two versions of a file it keeps both, the second under a name like `capture-… (sync conflict 2026-07-23 1340 211f13).webm`. The orphan sweep saw that as a recording of its own and transcribed and extracted the whole meeting again, leaving a duplicate note to reconcile by hand and a second bill for work already done. Queued meeting notes have been deduplicated against their conflict copies for a while; the audio sweep never was, and now is. Both halves of the sweep skip them, and say so in the console.

## 1.75.2

### Fixed

- **A YouTube capture no longer pays before it checks.** It fetched the transcript, optionally transcribed the audio, ran the extraction, and only then looked to see whether a note for that video already existed, refusing at the end and throwing the work away. Video captures have always checked before their download; this one paid for both halves first, which is how an extraction can sit in the usage meter with no note anywhere to show for it. The check now happens as soon as the title is known, before anything is spent.

## 1.75.1

### Fixed

- **A second post from the same day is no longer refused as a duplicate.** Every link capture checked whether a note already sat at the filename it had worked out, and gave up if one did. But that filename is the date plus the title, and a post's title is its own first words trimmed to fit a filename, so two different posts from one day that open the same way produced the same name and the second was dropped with a notice that read as "you already have this". The note in the way is now asked what it captured: the same link still stops the capture, and names the note that already has it, while anything else is written alongside as `-2`, the way two meetings on one day already were. Matching is by post or video id where there is one, so a share link with `?s=43&t=…` on it, the legacy `twitter.com` host, and a `youtu.be` short link are all recognized as the thing you already captured; other links compare without their query or trailing slash. Videos and web pages had the same guard and get the same fix.

## 1.75.0

### Added

- **Re-extract a whole folder.** The extraction gets better over time, and until now catching a folder up meant opening every note and running Re-extract on each one. Right-click a folder that holds captures and pick **Re-extract captures here…**, or run **Re-extract every capture in a folder…** from the command palette. The dialog says how many notes it found before anything runs, and by default each note gets the sections that suit its own kind, so a mixed folder does not have to be sorted first: a post takes the short set, a page your web sections, a meeting your meeting sections. Pick one set for all of them instead if you would rather.

  It runs one note at a time, naming the note it is on, because each one costs an extraction. **Stop the bulk re-extract** ends it wherever it has got to, and everything already done stays written. Nothing else in a note is touched: transcripts, posts, articles, moments, carried-over items, and audio embeds all survive, and the run ends by telling you how many notes were rewritten, how many had no captured text, and which ones failed.

## 1.74.1

### Changed

- **Re-extract opens on the sections that suit the note.** It always started from your meeting sections, whatever it was pointed at, so re-extracting a captured post offered Action items and Decisions and had to be corrected by hand every time. A note's own heading says what it is: a post starts on the short Summary, Key takeaways, and Keywords set, a captured page starts on your web sections, and everything else keeps the meeting set it always had. All of them are still yours to change before running it.

## 1.74.0

### Changed

- **A capture no longer repeats its own name.** Obsidian shows a note's filename above the note, and every capture then opened with a `# Title` line saying the same words again, one line down. The heading is left out when the filename already carries the title, which is what the default filename patterns do. A pattern that drops the title, like `{{basename}}-notes`, still gets a heading, so no note ends up nameless. Existing notes are untouched, and everything that reads a note back (re-extract, the Word export, folding a recording into a meeting note) copes with a note that has no heading.
- **A text-only post asks for fewer sections.** Facts & figures, Resources mentioned, and Questions have nothing to say about two sentences, and Notable quotes just quoted the post back, all of it above the post itself. A post with no video now asks only for Summary, Key takeaways, and Keywords. It narrows your picks in Video and social sections and never widens them: switch one of those three off and it stays off. A video is unchanged and still gets the full set.

## 1.73.2

### Fixed

- **A captured post now leads with the post.** An X capture stored the post's own words under a "Post" heading at the very bottom of the note, below the summary, the key takeaways, and every section that had nothing to say about two sentences. Reading the thing you captured meant scrolling past the notes about it. A post's words now sit directly under the title, with the extraction below them. A video's transcript is long and is a by-product of the notes, so it stays where it was, under them; the same goes for a web page's article text.
- **Re-extract works on posts and pages.** It looked for a "Transcript" section and nothing else, so a captured post or article, which stores its text under "Post" or "Article", reported that there was nothing to re-extract from. All three headings count now, and a re-extract leaves the captured text alone wherever in the note it sits.

## 1.73.1

### Changed

- **Notices suit a light theme now.** Obsidian paints every notice as a near-black slab, which reads as part of the UI in a dark theme and as an error box in a light one, whatever it says: "Building embeddings 12/46" is progress, not a failure. Notices take the theme's own surface, border, and text colors in light themes; dark themes are untouched.

## 1.73.0

### Added

- **"Edited 3 minutes ago", on the note itself.** Obsidian tracks every file's modified time and never shows it to you. A quiet line now can: under the note's title, under the title with a hairline between the two so the title and the date read as one page header, at the end of the note, or both, with the time reading as a relative age, an exact date, or both. Clicking it shows the exact date for that note whatever the setting says, and hovering always does. It reads the file's modified time, except where the note carries its own `updated:` (or `modified:`) property, which wins: in a synced vault the sync client rewrites modified times on download, and a note edited last week on another machine would otherwise claim to be edited the moment it landed. Off by default, under a new **Notes** tab in settings. Power Editor has drawn this line for a while and keeps owning it wherever it is installed, so a vault running both never stamps a title twice; this is the same feature for a vault that only has Power Assistant.

## 1.72.2

### Fixed

- **Renaming one speaker no longer publishes every speaker's settings over sync.** `data.json` is a synced file, so a save may only carry the keys this device changed since it last read it. That was true per top-level key, and `noteVoices`, `speakerColors`, `speakerEmoji` and `seriesTemplates` each hold one entry per speaker or series behind a single name. Recolouring one speaker marked the whole map as this device's and wrote it over the disk's, erasing every voice another device had learned since this one last read. Per-item maps now merge entry by entry: start from the disk so anything set elsewhere survives, drop only what was deliberately removed, then lay this device's changed entries on top. Two devices editing the same speaker still settles last-writer-wins, but that is one entry losing a race rather than all of them. Arrays keep merging whole, since a list's order and membership are the thing itself. Found in Power Explorer, where it was eating manual folder orders across five devices; the same fix went out across the Power family.


## 1.72.1

### Fixed

- **The queue count and the sweep now agree on what "pending" means.** The count and the processor were applying different rules, so a status bar reading "Assistant queue: 4" could be clicked into "no pending recordings were ready to process", with the 4 still sitting there afterwards. Two causes, both in the counter. A recording whose run failed was excluded from the count as a note (failed work waits for a person, on purpose) and then counted right back in as unlinked audio, because a failed note carries an error callout and no audio embed; the sweep refused it correctly, and the number never moved. And a rotated recording's part 1 was counted whether or not its stitching sidecar still existed, while no sweep on any device will take a part file without one, so a lost sidecar meant a permanent, unworkable +1. The counter now asks the same questions the sweep asks. Items that genuinely need a person are no longer counted as queue: they are named, with what each one needs, when you click the count or run the command, and the status bar says "N need you" rather than going blank on them.

### Added

- **The queue count is a button now.** "Assistant queue: 4" said work was parked but did nothing when you clicked it, which left the command palette as the only way to act on the very thing the status bar had just pointed at. Clicking the count now runs the same forced sweep as "Process pending recordings on this device now", with whatever providers this device has. It only takes the click while something is actually waiting (an empty item does not hover like a button over nothing), and a click during a run says the queue is already being worked rather than stacking a second sweep behind the first.

## 1.72.0

### Added

- **Crosstalk is labeled, not misfiled.** Overlapping speech used to be silently credited to whichever single voice dominated each stretch, which is exactly how a "no, wait" interjection lands under the wrong name. The WhisperX server now reports when two or more diarized turns genuinely overlap inside a transcript segment (a clean handover between speakers is not crosstalk, and boundary jitter is ignored), and those turns render as **Crosstalk (Steve + Speaker B) [1:02]:** with a muted voice-count badge instead of one speaker's color and click menu. The words are still the dominant voice's, since transcription follows the strongest signal; the label is honest about who else was talking, the stamp still plays the moment, and renaming a speaker reaches inside crosstalk labels. A voice heard only in overlap still gets its letter, so it can be named, enrolled, and recognized next time. Update the server copy (Show install steps, then restart it) to start getting the marks; an older server keeps working without them.

### Fixed

- **Voiceprints actually leave the server now.** whisperx's diarizer returns its turns as a table, not the pyannote object the embedding pass expected, so every embeddings request failed quietly before reaching the model and voice identity (1.71.0) had nothing to learn from on a stock install. Both the embedding and crosstalk passes now read turns through one normalizer that accepts either shape. This fix ships in the server copy: press "Show install steps" again on the box that runs it, and restart the server.

## 1.71.1

### Fixed

- **Show install steps now survives an antivirus that blocks the write.** Bitdefender and friends treat a plugin writing a .ps1 script as dropper behavior and deny the write outright (EPERM at open), which aborted the whole export with a bare error. Each file now writes independently with a remove-then-retry second chance, whatever can be written always lands (server.py is what a running box actually needs), and the failure message names the missing files and the honest ways out: an antivirus exclusion you choose to make, or copying the files from a synced device or the repo's tools/whisperx-server. Nothing gets renamed to dodge a scanner, on principle.
- The Show running version marker had quietly stayed at 1.70.4 through the 1.71.0 release; it reads 1.71.1 again.

## 1.71.0

### Added

- **Voice identity: name a speaker once and the plugin recognizes the voice from then on.** Opt-in on the Meetings tab, off by default because voiceprints are biometrics. With it on and WhisperX transcribing, every substantial turn's voice is compared against the people you have named before: a recognized voice appears as the sparkles suggestion at the top of the letter's menu, voice suggestions outrank the text guesses, and Claude is only asked about the letters the voices could not answer, so a fully recognized meeting skips that call and its tokens. Naming a letter, from the one-click menu or the Name all dialog, is what teaches the library, gated on about four seconds of speech so a clipped "No." never defines anyone. Prints live in a synced vault file (default `_resources/voiceprints.json`), are computed only by your own server, and every person has a Forget button that truly deletes.
- **A merged "Speaker 2" is split apart by voice.** The classic failure in a one-hour ten-person meeting: diarization files two or three quieter people under one letter, and no amount of naming can fix it afterwards. The server now returns a voice vector per diarized turn (when embeddings are requested), and before the note is written each cluster is audited turn by turn against the library; when a letter's turns disagree, the minority voice's turns move to the letter that voice already owns, or to a fresh letter, with a notice saying exactly what moved. The bar to move turns is deliberately higher than the bar to suggest a name, and with no library the transcript comes through untouched.
- **The meeting invite now bounds the diarizer.** A meeting imported from the calendar sends its attendee count to WhisperX as max_speakers, reining in the clusterer's habit of inventing extra speakers in big meetings. A ceiling only, never a floor: two of ten invitees doing all the talking is normal, and a floor would split a real voice into phantoms.
- **Rotated recordings share one speaker space.** Multi-part recordings used to come back as per-part 1A/2B seats, so the same person needed naming once per part. With voices on, a later part's letters are aligned to the earlier parts by voice and the whole meeting reads as one cast.

### Changed

- **The server prefers pyannote community-1 and says which pipeline loaded.** community-1 counts speakers in big meetings far better than 3.1, which is exactly the failure above. The server now asks for it by name and falls back (library default, then 3.1) when the token has not accepted its terms; /health reports `diarization_model`, and Check server shows it ("speaker labels on via community-1"). If yours reports 3.1, accept community-1 on Hugging Face and restart the server to upgrade.

## 1.70.4

### Fixed

- **The setup script no longer looks like malware to antivirus.** 1.70.3's fallback for policy-blocked Task Scheduler wrote a launcher file into the Startup folder, and a script that drops files into Startup is exactly the persistence pattern antivirus heuristics exist to catch: Bitdefender quarantined the exported setup.ps1 on sight, before it ever ran. The fallback now prints two manual steps (open shell:startup, create a shortcut to the run script) instead of writing anything itself. Same auto-start, no dropper signature, and the setup script stays out of quarantine.

## 1.70.3

### Fixed

- **Speaker labels survive the new WhisperX stack, and gated-model problems say so out loud.** Three separate failures conspired to turn labels off silently. The pyannote 4 era renamed the auth argument, so the server's diarizer load raised a TypeError that was caught as "diarization unavailable"; the server now speaks both spellings. Newer whisperx also switched its default pipeline to pyannote/speaker-diarization-community-1, a separate gated model nobody had accepted; the server now falls back to speaker-diarization-3.1 when the new one is refused. And the deepest trap: Hugging Face's metadata API answers 200 for gated models even when their terms were never accepted, so everything looked authorized while every actual file fetch got 403. Setup now proves the token against the real files, prints ok or BLOCKED per model with the exact page to accept, and notes that fine-grained tokens need the gated-repositories read permission. The token instructions list all four models (segmentation, both diarization pipelines, and the voiceprint embedder).

## 1.70.2

### Fixed

- **Rerunning the WhisperX setup can no longer trade the GPU for a CPU PyTorch.** The script installs CUDA PyTorch first and the server's requirements second, and when a requirements bump asked for a newer torch, pip resolved it from plain PyPI, whose Windows wheels are CPU-only: the upgrade quietly uninstalled `torch 2.6.0+cu124` and installed a CPU build, parking the GPU while everything still "worked". The requirements install now carries the CUDA wheel index whenever an NVIDIA card is present, so a torch upgrade resolves as `+cu128`, and a final check restores the CUDA build if a CPU one ever sneaks through anyway. Both setup scripts (Windows and Linux/macOS) get the same treatment, and the base install moves from the cu124 to the cu128 wheel line to match the torch 2.8 era. An installation already bitten by this is healed by simply rerunning the setup script.
- **The logon registration tells the truth, and works on managed machines.** `schtasks` is denied by policy on some corporate Windows boxes; the script used to print "registered task" over the error anyway, so the server just never came back after a reboot. A denied registration now falls back to a launcher in the per-user Startup folder (same effect, no policy fight) and says exactly which of the two it did.

## 1.70.1

### Fixed

- **Diarization letters can no longer become standing corrections.** Corrections exist for misheard words (Shaker → Sekhar) and are applied to every new transcript, but the old click-a-label gesture could save "Speaker A → Darwin" as such a rule, and letters rotate with every recording: the next meeting's Speaker A is a different person, silently pre-labeled Darwin before the naming step even ran. Saved rules like that are now dropped at load (a notice lists what was removed), the Correct dialog applies a letter term to the current note only and says so instead of remembering it, and the speaker menu no longer offers the standing-correction Rename for lettered voices at all, since naming a letter is what the one-click "This is …" items are for.

## 1.70.0

### Changed

- **Speakers are now named on the transcript itself, the way Otter does it.** The "Who was speaking?" dialog stopped being the default. A diarized recording now finishes straight into its note (a standalone capture opens it for you; a meeting note is already open), with voices lettered A, B, C. Click anywhere in a turn's words in Reading view and that turn plays, so you can actually hear who is talking; click the letter and the menu offers "This is …" with one-click choices: the AI's guess for that letter, the note's own attendees, then frequent attendees from earlier meetings, plus a type-your-own entry. One click names every turn with that letter; a wrong single line is still fixed with Move this turn. The old up-front form is still there for anyone who wants it, as Name speakers on the Meetings tab (In a dialog first), and the Rename speakers command opens it regardless.
- **The AI's name guesses became suggestions instead of assertions.** They used to arrive prefilled in the dialog, which read as answers rather than guesses, and wrong ones got applied with one hasty Apply. Now they sit at the top of the label menu marked with a spark, one click when right and zero cost when wrong.

## 1.69.0

### Added

- **The mic button asks where a recording should go.** A quick recording (the mic ribbon icon or Start / stop recording, with no meeting note involved) used to become a capture note in the output folder, full stop. Now, when one stops, a small dialog asks whether it should be a meeting note or a capture. Meeting creates the note in the Meetings folder, named by date and title (type one in the dialog, or it is simply "Meeting"), transcribed with the meeting provider, and folded in exactly as if the recording had been started from that note, series carry-over included; Capture keeps the old path. Closing the dialog keeps it a capture, and on a record-only device the Meeting answer queues the note for the processor machine like any other meeting. The audio is claimed for the dialog before the question is even asked (the auto-processor consumes its create event up front), so nothing double-processes however long the answer takes; a recording left unanswered across a restart is simply saved, and Process pending recordings picks it up. Recordings started from a meeting note never ask. The dialog can be turned off on the Meetings tab (Ask where a quick recording goes), which restores the old always-a-capture behavior.

## 1.68.0

### Added

- **Hear a speaker before naming them.** The "Who was speaking?" dialog now carries a play button beside each voice: it plays that speaker's longest turns straight from the recording, and each click moves on to the next clip, so "who IS this?" is answered by listening instead of by squinting at someone's first words (which, in a meeting that opens with cross-talk, are routinely garbage). The same buttons appear in **Rename speakers in this capture**, where the clips come from the note's own audio embeds, located by the transcript's stamps.
- **Move one turn to the right person.** When the diarizer glues two voices under one label, renaming the label just paints the wrong name onto both people; the fix has to be per line, and until now it meant hand-editing Markdown. Click a speaker's name or avatar in the transcript (Reading view or Live Preview) and choose **Move this turn to someone else**: the note's other speakers are one click, anyone else types ahead from known attendees, only that one line changes hands, the talk-share line recomputes, and the attendees list trues up (the new person joins; the old one leaves only when none of their turns remain). **Play this turn** sits in the same menu. Reading view also now badges and colors named speakers in plain transcripts, which previously only legacy callout transcripts got.

### Fixed

- **Deepgram now separates voices with its next-generation diarizer.** Recordings were being split by Deepgram's original v1 speaker model (the legacy `diarize=true` parameter routes there), and that model is exactly what kept hearing two colleagues as one "Speaker B". Requests now ask for the v2 diarizer, trained on a far larger voice corpus and much better at telling similar voices apart. The speech model setting (nova-2 or nova-3) is separate from this and unchanged.
- **Multi-part recordings weigh talk shares and audio minutes correctly.** When a long recording rotates parts, each part's segment start times were shifted onto the whole-meeting clock but the end times were not, so every turn after part one read as zero-length: talk-share percentages leaned toward part one's speakers, and the metered transcription minutes under-counted. Ends now shift with their starts.

## 1.61.0

### Fixed

- **A command that needs Microsoft 365 now walks you to the fix.** Sign-ins have been per device since 1.52.0, so a machine that never connected sits silently not connected even while your other devices work fine, and the short "connect first" notice read as nothing happening. Import meeting from calendar, the New meeting dialog's From calendar button, and Email this page now say plainly that Microsoft 365 is not connected on this device and that sign-ins are per device, keep that notice up for ten seconds, and open the plugin's settings on the Meetings tab so the Connect button is already on screen.

## 1.60.0

### Added

- **A captured X post brings its context with it.** A quote-post's own words routinely mean nothing alone: "Way more than a billion" is a note about nothing until you know it was answering "A population of 1 billion builders is coming." The post being quoted, and the post being replied to, now come along as attributed blockquotes, so the note reads as the exchange rather than as a fragment, and the extraction has something to work with. The post is still titled and filed by its own words, never by what it was quoting. Captures also gained the exact posted date (rather than a date reconstructed from an anchor label), the like count, and the reply count.
- **Why the replies themselves are not there.** X serves the conversation under a post only to a logged-in client: its public embed reports how many replies there are and none of their text, and the old syndication conversation endpoint now answers empty. Getting the actual replies would take a paid API key or driving a logged-in session, so the reply count is captured instead and the note records how much discussion a post drew without pretending to hold it.

## 1.59.0

### Added

- **Your order mail becomes line-item spending.** Power Desk watches your mailboxes and hands over the messages your rules match; each order becomes a note, and each thing you bought becomes its own note beneath it, so a report can add up groceries or software instead of "Amazon, $184.62". Mail rules match on sender, subject, and attachments, and can pin a vendor name (bills routinely arrive from a billing service rather than the company itself) and a scope, which is what keeps company spending out of the household rollup. The AI proposes the numbers and the vendor's own printed subtotal disposes: anything that fails to reconcile is still written, flagged `review: true` with the reason stated, because a silently dropped order is worse than a visible questionable one. Real order mail breaks a different naive assumption per vendor, so the reader also handles several orders in one message, responsive templates that render each line twice, recommendation blocks that look exactly like purchases, and prices split across table cells.
- **Four commands around that.** **Import Amazon order history** backfills from an Amazon "Request My Data" retail export, which is the sanctioned route to your own history: no scraping, no stored credentials, and already line-item grained. **Categorize uncategorized purchases** sorts a backlog into the taxonomy a hundred at a time, so a large backfill stays a handful of AI calls. **Spending rollup** writes the personal or business summary. **Create the Spending base** builds category, month, and vendor views plus a review queue, with a chart when Power Bases is installed. Everything is configured on the new **Transactions** tab; emptying the folder setting turns mail-driven capture off entirely.
- **Ask your vault can answer from your email.** A rolling window of recent mail, indexed locally, so "what did the electric bill run last month" or "what did Dana send about the contract" is answerable without turning a mailbox into notes. Nothing is written to the vault and nothing syncs: the index lives in the plugin's own folder, is derived data that rebuilds from the mailbox, and drops whatever ages past the horizon on every refresh, so its cost tracks the window you chose rather than your mail history. Answers cite the message, and the citation links back to Outlook. Off until you set **Mail search window (days)**, and it needs Power Desk with a mailbox connected.

### Fixed

- **An X post that is only words no longer needs yt-dlp.** Capturing one asked yt-dlp first, and on a machine without it the capture stopped there with a setup hint, even though most posts are text and their text comes from X's own oEmbed endpoint, which needs nothing installed. A missing yt-dlp now routes exactly the way yt-dlp refusing a post already did: an X post falls back to its text, anything else falls back to the page reader, and the notice names what was skipped, so a post that really did carry video cannot lose its transcript quietly. The oEmbed call also goes straight to `publish.x.com`, where the `publish.twitter.com` address it used to name now redirects.

## 1.57.0

### Added

- **Local AI setup is now one button and one command.** The WhisperX server ships inside the plugin: **Show install steps** (API keys tab, WhisperX section) writes the server files out next to the plugin and hands you the single `setup.ps1` / `setup.sh` command to paste into a terminal. The script finds Python (and tells you the winget command if it is missing), builds a private environment outside your vault, installs PyTorch matched to your GPU, asks for the Hugging Face token that turns on speaker labels (Enter skips it; transcription works either way, and rerunning the same command adds the token later), registers the server to start whenever you log in, starts it, waits for it to come up, and prints the exact address to paste into settings, using your machine's network address so every synced device learns it at once. The plugin never runs installers itself: you see the one command, and you run it.
- **Detect local AI.** A button in the AI model section probes this machine for Ollama and the WhisperX server and fills in both endpoints (again with the network address, for the whole fleet). It fills endpoints only; switching the provider dropdown to Custom endpoint stays your explicit call.

### Added

- **Extraction evals: the model choice becomes a table.** Copy a few finished capture notes anywhere, add `pa-eval: true` to their frontmatter, and run **Run extraction evals**. The configured AI model re-extracts each note's transcript and a report note scores the fresh output against what the note already carries: sections present and missing, item counts per section, action-owner and keyword overlap, length ratio, and the complete fresh extraction quoted under each row for the read-through that actually decides. Point the AI model at Ollama, run the evals, point it back at Anthropic, run them again, and the "is the local model good enough" question answers itself on YOUR meetings. The same report catches a prompt change quietly regressing last month's notes.

### Fixed

- **A processor can no longer eat a meeting recording as a standalone note.** There was a window where audio synced in before its queued meeting note did, and the box's auto-processor would grab it as an ordinary capture; the meeting then transcribed twice into two places. Now only a device's OWN recordings and drops into a dedicated capture folder take the fast path; synced-in audio waits out a grace period and is taken only if no queued meeting note has claimed it by then, and the orphan sweep, the queue counter, and the watcher all honor those claims.
- **A sync conflict copy cannot double-transcribe a meeting.** Two notes queueing the same recording (the original and a "conflicted copy") are grouped; the original name processes, the copy is skipped and logged for you to resolve.
- **The WhisperX server got a job API.** Instead of one long HTTP request holding minutes of transcription hostage to a dropped socket or an Obsidian reload, the plugin now submits a job and polls it, AssemblyAI-style, and the meeting note narrates the server's stages ("separating speakers…") while it works. A dead connection mid-job costs a poll, not the transcription. The plugin still understands a v1 server that answers inline; update the server folder when convenient.

### Added

- **WhisperX: speaker labels from your own machine.** A fourth transcription provider that diarizes, no cloud account involved. Run the small server that now ships in `tools/whisperx-server` (Python; a CUDA machine is strongly recommended, and its README walks through the one-time Hugging Face token for the diarization models), point the new WhisperX section on the API keys tab at its address, and **Check server** tells you it is up and whether speaker labels are on. Meetings transcribed there come back as Speaker A/B turns with timestamps, so speaker naming, talk shares, attribution, and audio-jump all work exactly as they do on AssemblyAI or Deepgram, and the usage meter prices the minutes at $0.00. The diarizer's arbitrary numbering is normalized (whoever talks first is A), sentence fragments coalesce into turns, and a segment the diarizer could not label continues the last speaker rather than inventing a new one. If the server has no diarization token, its transcripts arrive unlabeled, like plain Whisper, and nothing breaks.
- With WhisperX in the provider lists (default and per capture kind), the fully local pipeline is complete: record on any device, transcribe and diarize on your box, extract with your own model over the custom AI endpoint, meet zero clouds on the way. The README's privacy section spells out the whole path.

### Added

- **Device roles: record anywhere, process on the machine you choose.** The "Process on this device" toggle grew into **This device's role** (Transcription tab): *Record and process* is everything as before and stays the default; *Record only* saves audio, marks it pending, and touches no API; *Processor* additionally watches the synced vault and claims what the other devices parked. The role lives in per-device storage next to your keys, so one synced data.json can no longer flip your whole fleet at once (which the old toggle, quietly, could). A phone with the old toggle off wakes up as *Record only* without being asked.
- **A meeting recorded on one device now finishes on another, into the same note.** Ending a meeting recording on a *Record only* device writes the queue into the meeting note itself: which recordings, each part's timing, your chosen sections, your marks. When the audio syncs over, the processor claims the note, shows "Transcribing the recording (on pc-4f2a)…" right where you would have seen it locally, and folds in the transcript, speakers, and summary exactly as if it had been there in the room. Before this, a recording that crossed devices came back as a stranded standalone note with no idea a meeting note was waiting for it.
- **Claims, not collisions.** Two processors (or your desktop and the new box) cannot double-transcribe one recording: standalone audio is claimed by writing the output note first as a small working stub, queued meetings by a stamp in their frontmatter, and both wait out a settle pause before starting so a near-simultaneous rival claim loses cleanly. A claim whose device dies mid-job goes stale after 30 minutes and the work is retaken; a run that fails leaves a visible failed page saying exactly why, and deleting that page is the retry. Nothing retries a poisoned file forever, and nothing is silently dropped.
- **The queue is visible.** The status bar shows "Assistant queue: N" whenever recordings are waiting (meeting or standalone), on every device. The command **Process pending recordings on this device now** is the manual override from anywhere, using whatever providers this device has; a device with no transcription keys declines politely instead of claiming work it cannot do.

### Changed

- **A processor coming online does not bulk-eat your archive.** The orphan-audio sweep only reaches back seven days for plain audio files, so years of deliberately unprocessed memos are not surprise-transcribed at cloud rates the first time a box boots with the new role. Queued meetings and rotated-session sidecars are explicit intent and never expire. Rotated standalone sessions park their part timing in a small `.pa.json` next to the audio; if your sync service filters file types, let it sync those.

### Added

- **The AI can run on your own machine.** A new **AI model** section at the top of the API keys tab picks where every AI call goes: **Anthropic (cloud)**, exactly as before and still the default, or a **Custom endpoint** you run yourself. Ollama (0.14 and later), LM Studio, and llama.cpp all speak the Anthropic Messages API now, so the plugin sends the identical calls to your server and nothing about the notes changes shape. Summaries, action items, speaker naming, Ask your vault, the assistant chat, the writer, and slide reading all follow the one setting; transcription and embeddings keep their own endpoints as they always have. The custom fields are the server's base URL, the model name as the server lists it, and a key only if your server checks one (local servers usually do not). Your Anthropic key stays put, untouched, for switching back. Two things to know: reading slide images needs a vision-capable model on your server, and a custom setup left half-finished gates the AI features with a "set the AI endpoint and model" notice rather than quietly billing the cloud you had just opted out of.

### Changed

- **The usage meter tells the truth about a $0 bill.** Custom-endpoint calls are metered like every other call (tokens counted, per-feature lines intact) but priced at $0.00. The cost line used to round any nonzero work up to ≈$0.01, which was honest for the cloud and a lie for a machine in your own house.

## 1.48.0

### Added

- **Email any page, whole or summarized.** *Email this page* (right-click a note, or the command) sends it from your own Microsoft 365 mailbox, with a line of your own on top, and files it in your Sent Items like anything else you send. The connection was already here for the calendar, so this is mostly a use for it. A note is written for the vault it lives in, so what leaves is flattened for someone who does not have one: wikilinks become their own words, embeds and block ids go, callouts keep their title and their quote. Your `%%comments%%` and the note's frontmatter are removed before the mail is built rather than after, because those are the two that are about privacy rather than tidiness: comments are the syntax Obsidian gives you for writing something only you will read, and frontmatter is bookkeeping that tends to collect costs and sources. Sending cannot be taken back, so nothing is one click: you see the mail as they will read it before **Send** does anything, and Send stays dark until there is a valid address and something to put in it.

### Changed

- **The Microsoft 365 connection now asks for permission to send mail as you.** An existing connection agreed to the calendar permission only, and Microsoft will not hand back a token for a permission nobody agreed to, so the next refresh will ask you to **Connect** once more. Nothing is lost, and the new sign-in covers both. Add **Mail.Send** to your Azure app's delegated permissions alongside Calendars.Read.

## 1.47.0

### Added

- **MSN links capture.** MSN builds its pages in the browser, so the page a fetch gets back is a script shell with the article nowhere in it: every MSN link answered "could not find an article on that page", and the advice it offered, to try again as a video, could not have helped because the story was never missing, only unreachable. MSN serves the text separately, keyed by the id already sitting in the link, so that is where the article now comes from. Since MSN mostly carries other outlets' reporting, the note credits the publisher that wrote the piece and links their original article rather than the MSN feed link, which is a tracking URL for a slot on a page that will not exist tomorrow. A Newsweek story read from MSN files under `Newsweek`. Any other site is unaffected, and an MSN link that does not answer falls back to the ordinary reader rather than failing outright.

## 1.46.3

### Fixed

- **A post without a video captures its text instead of failing.** Pasting an ordinary X post reported "No video could be found in this tweet" and stopped, which is most posts. yt-dlp only knows about video, so its refusal now routes the capture rather than ending it: X posts are read through X's own public oEmbed, and links from anywhere else fall through to the web page reader. A post is its words; the audio was only ever a bonus.
- **A video with no speech no longer vanishes without a word.** A clip with nothing spoken in it (a reaction video, music over a still) transcribed to an empty string, and the capture then returned silently: no note, no error, nothing. The three outcomes are now kept apart, so a real failure reports, a speechless clip saves the post's own text and says why, and only a post with neither speech nor text refuses, out loud.
- **A post's text is never dropped by the transcript setting.** When the note's content is the post's own words rather than a transcript, it is always kept: "include the transcript" is about a by-product of transcribing, and applying it to a text post would have written an empty note.

## 1.46.2

### Changed

- **No provider prices are quoted anywhere in the settings or the docs.** The transcription and Deepgram descriptions carried per-hour rates and a starting-credit figure, and the model field claimed a per-meeting cost. A number baked into a plugin goes stale without anyone noticing, and stale pricing is worse than none: it is believed. Each provider's own pricing page is now the pointer, and the AI usage meter still reports what this vault is actually spending, from the token counts the APIs report.
- **The recognized sites are a scannable list, not a sentence.** Twelve site names buried in a paragraph made you read to find out whether yours was there. They are chips now, and Instagram, Facebook, and LinkedIn carry a lock, because those three show a logged-out visitor almost nothing: supported and will-work-for-you are different promises, and the list should say which is which.

## 1.46.1

### Changed

- **A new vault now files captures under Sources.** The defaults are `Sources/Social/{{site}}` for videos and posts, `Sources/YouTube`, and `Sources/Articles`, each named `{{date}} {{title}}`, so a fresh install gets a coherent shelf instead of everything landing in the output folder together. Nothing already configured is touched: your own settings win over defaults, as always.
- **The web folder no longer suggests {{site}}.** The token still works there, but it suits social and not the web. For social it is a dozen tidy labels (X, TikTok, Reddit); for a page it comes from that page's own `og:site_name`, which is unbounded and often untidy, so it means a new folder per publication. One folder reads better, and since the site is a property on every note, a Base can still group by it.
- **The Cookies from browser setting is honest about Windows now.** It said to pick your browser and gated sites would work. In practice, on Windows, Chrome and Edge encrypt their cookie stores in a way yt-dlp usually cannot read: Edge reports a DPAPI failure, and Chrome also locks its database while it is running. Firefox is the reliable one there. The setting also notes that it applies to every download, not only the gated sites, so leaving it on sends your session to sites that never needed it.

## 1.46.0

### Added

- **Capture from a link.** One command, **Capture from a link…**, takes any URL and decides how to read it: a YouTube video uses its free captions, a video or social post is downloaded and transcribed, and anything else is read as a web page. The dialog says which one it picked before you commit, and a **Read it as** dropdown overrides it for the blog that is really a video page, or a video site it does not recognize.
- **The other social sites.** X, TikTok, Instagram, Facebook, Reddit, LinkedIn, Bluesky, Vimeo, Twitch, Rumble, Dailymotion, and SoundCloud are recognized by name, and roughly 1,750 more work if you choose Video in the dialog. Adding them cost almost nothing: yt-dlp reports the same fields for every site it supports, so one reader serves all of them, and the note records which site a capture came from.
- **Capture a web page.** Run **Capture a web page…**, or just paste an article link. The page is fetched, reduced to the article with Mozilla's Readability (the engine behind Firefox's Reader View), converted to Markdown, and extracted into the usual sections. The full article is kept under an **Article** heading so it stays searchable and quotable after the page changes or disappears. No audio and no yt-dlp are involved, so a page costs no transcription at all; only the AI extraction costs anything, and that is optional.
- **File captures by source with {{site}}.** The folder and filename patterns take a `{{site}}` token, so `Social/{{site}}` keeps X and TikTok apart and `Reading/{{site}}` files articles by publication, without a settings tab for every site.
- **Cookies from browser, for the sites that require a login.** Instagram, Facebook, and LinkedIn show almost nothing to a logged-out visitor. Pick your browser (Chrome, Chromium, Edge, Firefox, or Brave) and yt-dlp borrows that session for the download. Off by default, and off means nothing reads your browser; nothing is ever copied into the vault or the settings.

### Changed

- **The X tab is now the Links tab,** covering every kind of link in one place, with its own folder, filename, sections, and transcription provider, plus a separate set for web pages. The **Capture an X post…** command still works and now runs the shared path.

## 1.45.0

### Added

- **Capture an X post.** Run **Capture an X post…** with a link to a post that has video, and it becomes the same structured note a YouTube capture produces: summary, takeaways, quotes, and the transcript, with the author, handle, post date, views, and likes as properties. X publishes no captions, so the audio is downloaded and sent to your transcription provider; this always costs credits, and the command says so up front rather than after the download if no key is set. It also checks for an existing note before spending anything, and it pulls the audio-only track, which is roughly a tenth of the bytes of the video.
- **An X settings tab.** Its own folder, filename pattern, section checklist, and transcription provider, kept separate from the YouTube ones. Videos and posts are different enough to want different answers.
- **A yt-dlp path setting, with a Check button.** Downloading a post's audio needs yt-dlp, a separate free program (`pip install yt-dlp`). Leave the path empty and the plugin searches your PATH and then runs yt-dlp through Python, which is what a pip install usually leaves working: pip drops the launcher into a Scripts directory that frequently is not on PATH, so being installed and being runnable come apart here more than they do for most tools. Check reports the version, so whether it is set up is answerable without capturing anything.

### Fixed

- **The Meetings and Finances bases open without Power Bases installed.** Both commands wrote views only Power Bases can draw, so in a vault without it the generated file opened as an unrenderable view: a broken result from a command that gave no hint it depended on another plugin. They now fall back to Obsidian's own table, which every vault can render, and the notice says the file is a plain table and what installing Power Bases would add. With Power Bases installed nothing changes.

## 1.44.1

### Changed

- **Section intros sit in a box like every other setting.** The paragraph that opens a settings section was loose text floating outside the cards, so it neither matched nor lined up with the rows beneath it. Each one is now a proper setting row, which also fixes the Documents, AI usage, Microsoft 365 calendar, and Semantic search sections.

## 1.44.0

### Added

- **An API keys tab.** Every key the plugin uses now lives in one place: Anthropic, Whisper, AssemblyAI, and Deepgram, each in its own group with a "Key set" or "No key" pill. The Anthropic key and model moved here from the Extraction tab, and every transcription provider's keys are now always visible instead of only the selected one's, so you can set them all up once and switch without re-entering anything. Which providers you are set up for is a different question from which one does which job, and the answer no longer hides behind a dropdown or sits on whichever tab happens to use it.
- **Meetings, Capture, and YouTube each choose their own transcription provider.** Use Deepgram for meetings, where speaker labels matter, and Whisper for memos and videos, where they do not. Each dropdown marks the providers that have no key yet, and anything left on "Use the default" follows the Transcription tab as before. A recording folded into a meeting note counts as a meeting; a standalone recording from the ribbon counts as a capture.

## 1.43.0

### Added

- **An AI usage meter.** A new sidebar panel (command: "Open the AI usage meter", or the Usage meter button in settings) totals what this vault is spending, with Claude and transcription kept as two separate figures rather than one blended number. Break it down by feature, by model, and by day, over today, the last 7 days, the last 30 days, or all time. Every AI call now records its model and the token counts the API reports, so assistant chat, Ask your vault, and document extraction show up alongside meetings. It is all local: the meter reads its own log, never your provider accounts.

### Fixed

- **Cited notes now open when you click them.** Obsidian only wires `[[link]]` clicks inside its own markdown views, so every citation the plugin rendered itself looked like a link and did nothing: the assistant chat, Ask your vault, the meeting Ask dialog, the writer, and the live catch-up panel. All five open the note now, and Ctrl-click or Cmd-click opens it in a new tab.
- **Opus was priced at the old rate.** Cost estimates used $15/$75 per million tokens, which was Opus 3 pricing. Opus 4.x is $5/$25, so any estimate made on an Opus model read about three times too high. Haiku and Sonnet were already correct, and the Deepgram and AssemblyAI rates were accurate.

## 1.42.7

### Fixed

- **Opening a meeting note starts at the top again** instead of jumping partway down to the transcript. The player follows along and scrolls only while the audio is playing or you are scrubbing, not when a note first opens.

## 1.42.6

### Changed

- **Less space between speaker turns.** The blank line between turns was rendering as a full, empty editor line, which roughly doubled the gap. It is now collapsed, so speakers sit about half as far apart while each turn keeps its own padding.
- **The player bar matches the height of the app's bottom bar,** so its top edge lines up with the vault and settings footer beside it, on any theme or zoom.

### Fixed

- **Speaker avatars sit in a proper left gutter now, aligned with the transcript's headings,** instead of crowding the sidebar. A core Obsidian style had been overriding the gutter, so it never rendered no matter the spacing set.

## 1.42.4

### Changed

- **Transcript polish:** a little space to the left of the avatars, a shorter player bar (closer to the status bar's height), and the currently-playing turn now uses just the soft shading with no left border.

## 1.42.3

### Added

- **Scrubbing the player scrolls the transcript to that moment.** Drag or click the player's progress bar and the transcript jumps to and highlights the turn at that time, not just while playing.

### Fixed

- **Even spacing between turns**, including turns whose text runs onto a second line.

## 1.42.2

### Fixed

- **The player is now pinned to the bottom and ready immediately.** It no longer waits for you to scroll to the end of a long transcript, it drives the meeting's audio file directly and stays pinned to the bottom of the view while you scroll, so it is there from the moment the note opens.
- **More spacing between turns** so the transcript is easier to read.

## 1.42.1

### Fixed

- **The sticky player replaces the note's native audio player** instead of showing alongside it, and the status-bar labels no longer sit on top of it.
- **The avatar no longer overlaps the speaker name**, it sits in a left gutter with the name and text aligned beside it, and the timestamp underline is gone.

## 1.42.0

### Changed

- **The transcript now reads like Otter.** In Edit mode each turn shows the speaker's name in bold with the time in gray beside it, the avatar centered in a left gutter, and the spoken text on its own line below: no row shading, no underlined time, no brackets.

## 1.41.1

### Added

- **Alt- or Ctrl-click a word to play from there.** Holding Alt (or Ctrl) and clicking a word in the transcript jumps the audio to about that spot and plays. A normal click still just places the cursor to edit. The time is estimated from where the word sits in its turn, so it lands within a second or two.

## 1.41.0

### Added

- **A sticky, Otter-style audio player.** A player bar stays pinned to the bottom of a meeting note as you scroll the transcript: skip back or forward 5 seconds, play/pause, cycle the playback speed, and scrub a progress bar that shows the time under your cursor, plus the current and total time.
- **The transcript follows the audio.** As it plays, the turn playing right now is highlighted and scrolled into view, and clicking a timestamp jumps the audio to that turn.

## 1.40.1

### Added

- **Click a speaker's name** (not just the avatar) to open the speaker menu, and **click a timestamp to seek the audio** right from Edit mode, the same jump the reading view already had.

## 1.40.0

### Changed

- **The transcript is now plain, always-editable text instead of a callout.** It no longer switches to raw `> …` source when you click into it. In Edit mode it stays styled (avatars, speaker colors, clickable timestamps) and you edit it in place, the same view whether you are reading or writing. Click a speaker's avatar to rename them, change their color, or set an emoji.

### Added

- Commands **"Convert transcript to plain, editable text"** (this note) and **"Convert all transcripts to plain, editable text"** (every capture note) to move existing transcripts out of the old callout. Run the second one once to update your back catalog.

### Removed

- The "Collapse the transcript" setting, which wrapped the transcript in a callout.

## 1.39.4

### Fixed

- **Editing inside the transcript now keeps the card's tint** instead of dropping to a white background, so clicking in looks much closer to the rendered card.

## 1.39.3

### Fixed

- **Custom speaker colors now apply.** Picking a color from the custom color swatch takes effect the moment you choose it, instead of quietly doing nothing.
- **Color and emoji changes now show immediately in Edit mode**, not just in the rendered card.

## 1.39.2

### Fixed

- **The Edit-mode transcript card now actually renders.** The styling was being stripped from every line you selected, which in practice dropped the whole transcript back to raw `> …` source. It now stays styled (avatars, speaker colors, and hidden blockquote markers) while you read and edit inside it.

## 1.39.1

### Fixed

- **The Edit-mode transcript styling now actually turns on.** 1.39.0 detected Live Preview with a brittle DOM check that never matched, so the styling never applied. It now uses Obsidian's own Live Preview state field.

## 1.39.0

### Added

- **The transcript now stays styled and editable in Edit mode.** Previously, clicking into the transcript in Edit mode (Live Preview) collapsed it to raw `> …` source. It now keeps its card look, speaker colors, and avatars while your cursor is inside it, and you can edit any turn in place. The line you are actually on shows its plain Markdown, exactly like the rest of Live Preview, so nothing is ever locked. In Reading view and Source mode nothing changes.

### Fixed

- **The audio player shows its total length in Edit mode too**, not only in Reading view.

## 1.38.3

### Added

- **An emoji picker for speaker avatars.** Set emoji now opens a searchable grid of common emoji you can click, alongside a paste-your-own field and a Remove option, instead of an empty box.

### Fixed

- **The audio player now shows the total recording length.** Recorded `.webm` files usually omit their duration, so the player showed only a 0:00 that never filled in. The duration is now resolved on load, so the player shows the full length.

## 1.38.2

### Fixed

- **Clicking a timestamp or speaker in the transcript no longer un-renders it in Live Preview.** A click on a stamp link, speaker name, avatar, or the Highlights only toggle used to drop the editor cursor into the callout, flipping the whole transcript to its raw `> …` source. Those clicks now do their job (seek the audio, open the speaker menu) without disturbing the rendered view.

## 1.38.1

### Fixed

- **Renaming a speaker no longer jumps the note to the top or collapses the transcript.** When the note is open, a correction is now applied as in-place edits instead of rewriting the whole file, so your scroll position and the expanded transcript stay put.
- Removed the stale example text in the Correct dialog's Replace with box.

## 1.38.0

### Added

- **Speaker avatars and emoji (transcript block, phase 3).** Every turn now leads with the speaker's avatar: a colored circle with their initial, or an emoji you set from the speaker menu (Set emoji). The emoji is remembered per speaker and shown in every meeting they are in.
- **Comments.** An Add a comment to this turn command drops a comment that renders as a soft bubble under the turn (a line starting with a speech balloon). It stays plain Markdown, so it is searchable and survives export.
- Images and inline emoji already work, since the transcript is Markdown: paste or drag an image, or type/insert an emoji, in the note.

## 1.37.0

### Added

- **Pick your speaker colors (transcript block, phase 2).** Clicking a speaker name now opens a menu: rename them, or Change color to choose from a palette or a custom color, remembered per speaker across every meeting. Reset color goes back to the automatic one.
- **Highlights.** A Highlight the selection command marks text in a transcript, and a Highlights only toggle in the transcript header filters the view to just the highlighted turns.

## 1.36.0

### Added

- **A purpose-built transcript block (phase 1).** New captures put the transcript in its own `[!transcript]` callout instead of a generic quote, with its own icon and accent. Each speaker name shows in its own color, and clicking a speaker name opens the Correct dialog prefilled with it, so renaming a speaker is one click and is remembered for future meetings. The `[m:ss]` timestamps still seek the audio. An Upgrade the transcript to the new block command converts older notes. It stays plain Markdown, so search, Word export, Ask, re-extract, and corrections all keep working. More transcript editing (highlights, comments) is coming in later passes.

## 1.35.10

### Changed

- **The Correct dialog's Find and Replace with boxes now line up.** They share a fixed label column, so the two fields have the same left edge and width.

## 1.35.9

### Changed

- **Learned corrections now rename the attendee on future meetings too.** A remembered name swap (for example a full invite name to the short name someone goes by) is applied to the new meeting's attendees and talk-share line as well as the transcript, so the whole note is consistent without any manual fix.

## 1.35.8

### Changed

- **Correct a term right from the selection.** Selecting a word in a note and right-clicking now offers Correct "<that word>", so the fix is where you look for it. The command palette entry and the capture-note menu item are still there too.

## 1.35.7

### Added

- **Fix a misheard name or word, and have it stick.** Select the wrong text in a note and run Correct a name or term (also on the capture-note right-click menu): type the right spelling and it is replaced everywhere in the note, including speaker labels, in-line mentions, and, when the term is an attendee, the attendee link. Leave Remember for future meetings on and the fix is applied automatically to every new transcript, so captures get more accurate over time. Manage the learned corrections under Extraction in settings. This also handles swapping a long proper name from a calendar invite for the short name someone actually goes by.

## 1.35.6

### Added

- **Record straight from the calendar import.** Each meeting in Import meetings from your calendar now has a Record button next to Prep: it creates the dated meeting note from the invite and starts recording into it in one step, instead of prepping the note first.

## 1.35.5

### Fixed

- **A YouTube capture no longer vanishes when the AI step fails.** If note extraction errored after the transcript was fetched, the whole capture was lost with no page created. Now, as with meeting captures, the note is always written with the transcript and a warning callout showing what went wrong, so you can read it or run Re-extract to try the AI notes again. Extraction is also retried on transient errors.

## 1.35.4

### Changed

- **The Capture a YouTube video dialog is friendlier.** A pasted URL that is missing its https:// now gets it added automatically (some copies drop the scheme), the URL box is wider, and pressing Enter in it captures, the same as clicking Capture.

## 1.35.3

### Changed

- **YouTube captures split the channel into a name and a link.** The channel property now holds the readable channel name, with a separate channel url property below it carrying the clickable link, instead of the field showing a bare URL.
- **The AI model is now a tag, not a property.** Every capture drops the model property and instead adds the model (for example claude-haiku-4-5) as a tag alongside capture, so notes stay filterable by model without an extra properties row.

## 1.35.2

### Changed

- **The YouTube channel property is now a clickable link to the channel.** A captured video records the channel's URL (its @handle when available, otherwise its channel id) as the channel property, so clicking it opens the channel, the same way the source property opens the video. When no channel URL can be found, the plain channel name is kept.

## 1.35.1

### Changed

- **Help icons now cover the rest of the settings too:** the section checklists (Summary, Action items, Facts & figures, and the others, under both Extraction and YouTube), plus each saved Filing rule and Custom template. Every setting in the pane now has one.

## 1.35.0

### Added

- **Help icon on every setting.** Each setting now carries a small help icon after its name. Hover it for a soft card explaining what the setting actually does and how it behaves; click to pin the card open, click again or press Escape to close. The one-line descriptions stay in place, so the extra detail is there only when you want it.

## 1.34.2

### Changed

- **YouTube is now its own settings tab.** Its options moved out of the Capture tab into a dedicated YouTube tab, so audio capture and video capture no longer share a page.

## 1.34.1

### Changed

- **Cleaner settings tabs.** The tab bar now renders as flat underlined tabs instead of boxed buttons: the active tab is marked by an accent-colored label and underline, so the row reads as tabs rather than a strip of buttons.

## 1.34.0

### Changed

- **Settings are grouped into tabs with a search box.** The options are now split across Transcription, Capture, Meetings, Extraction, and AI & privacy tabs, so the whole list no longer scrolls as one long page. A search box at the top filters settings by name across every tab at once, so you can jump straight to one without knowing its tab.

## 1.33.0

### Added

- **Meeting details fold into the morning briefing.** Each meeting in Today's meetings now carries a collapsible "Details" callout with its attendees, location, and agenda, pulled from the meeting note or the live calendar invite. Meetings with no extra detail stay a single line, so the briefing only expands where there is something to expand.
- **Briefing folder setting.** You can now choose where morning briefings are saved. Empty keeps the previous behavior (a Briefings folder under the output folder).

### Changed

- **Morning briefing settings get their own heading.** Auto morning briefing, Briefing horizon, and the new Briefing folder now sit under a Morning briefing heading instead of trailing the meeting options.

## 1.32.1

### Changed

- **YouTube settings get their own heading** in settings, grouping the folder, filename, audio, and sections options together instead of trailing the capture options.

## 1.32.0

### Added

- **Transcribe YouTube audio.** A new **Transcribe the audio** setting (off by default) transcribes a video's actual audio through your transcription provider instead of relying on YouTube's auto-captions, so names and numbers come out right (auto-captions mangle both). It downloads the smallest audio stream, transcribes it, and removes the temporary file; it costs transcription credits and falls back to captions whenever the audio cannot be fetched. Off keeps the free caption behavior.

## 1.31.2

### Fixed

- **Sponsor reads stay out of the notes.** Extraction now ignores sponsor read-outs and ad segments, so a video's sponsor no longer shows up as a resource or in the summary.

## 1.31.1

### Fixed

- **Sharper video extraction.** Facts & figures now only reports numbers actually stated in the source and never calculates a derived figure (which had produced a wrong percentage), Key takeaways stick to the ideas and leave the raw statistics to Facts & figures so the two stop repeating each other, and Resources are limited to real external references. The extraction prompt also forbids computing numbers that were not said.

## 1.31.0

### Changed

- **Video-appropriate notes for YouTube captures.** Captured videos no longer get meeting sections (Action items, Decisions, Risks) forced onto them. New content sections are available everywhere (Key takeaways, Facts & figures, Resources mentioned, Notable quotes), and a new **YouTube sections** setting defaults YouTube captures to the content set (summary, takeaways, facts, resources, quotes, questions, keywords). Each is toggleable, so a tutorial can turn Action items back on. Re-extract an older video note to apply the new sections.

## 1.30.0

### Added

- **YouTube channel metadata.** A captured YouTube note now records the channel, view count, publish date, subscriber count, and duration as properties, so the video's details are queryable from Power Bases and visible at a glance.

## 1.29.0

### Added

- **YouTube filename pattern.** A dedicated **YouTube filename** setting with `{{title}}` and `{{date}}` tokens, so you can put the date (or anything) in front of the title, for example `{{date}} {{title}}`. Defaults to just the title, which also drops the old `-notes` suffix on captured YouTube notes.

## 1.28.0

### Added

- **Document filing rules.** Under Settings > Documents, add rules that route and tag a processed document by its extracted fields: conditions on vendor, type, an amount threshold, or text; actions to file it to a folder (with `{year}`, `{type}`, `{vendor}` tokens), add tags, and flag it for review. The first matching rule wins; no match keeps the default filing by type and year. This turns document processing into the organization scheme you actually want, per vendor or category.

### Changed

- **The assistant chat and the writer stream their replies.** Answers now type out live as they are generated instead of appearing all at once, so long replies feel far faster. If streaming is unavailable the whole answer still arrives as before.

## 1.27.0

### Added

- **MCP bridge.** A standalone Model Context Protocol server (in the `mcp/` folder) exposes your vault to Claude Desktop and Claude Code: search notes, read a note, list recent notes, and summarize finances, all read-only and available whether or not Obsidian is running. See `mcp/README.md` to connect it.

## 1.26.0

### Added

- **Semantic search (opt-in).** Point the new **Embeddings endpoint** at a local Ollama (`http://localhost:11434/v1`, model `nomic-embed-text`) or any OpenAI-compatible provider, and Ask and the assistant chat find notes by meaning, not just keywords: your question is embedded and blended with the keyword index through rank fusion, so "that meeting where we argued about pricing" surfaces even without the exact words. Embeddings are built for your indexed notes (quietly on launch, or with **Build embeddings**) and stored locally; leave the endpoint empty to stay keyword-only. With Ollama, nothing leaves your machine.

## 1.25.0

### Added

- **Finances rollup.** *Finances rollup* turns your processed bills and receipts into an overview note: totals per currency (never summed across currencies), upcoming and overdue bills sorted by due date, and spending grouped by vendor and by month. *Create the Finances base* drops a Power Bases file over the same documents (a sortable table colored by type and a calendar of due dates) so you can filter and sum them interactively.

## 1.24.0

### Added

- **Draft from context.** Right-click a meeting note (or run *Draft from this meeting*) and the assistant writes a follow-up email, status update, chat recap, thank-you note, or a custom piece, grounded strictly in that meeting's summary, decisions, and action items (the transcript is excluded). Pick a tone, add optional instructions, then copy the result or insert it into the note. *Draft from recent meetings* does the same over the last week, so "the status email from this week" has every meeting to draw on.

## 1.23.0

### Added

- **Morning briefing.** A sunrise ribbon icon (or the *Morning briefing* command) opens a start-of-day note: today's meetings (pulled from your Microsoft 365 calendar when connected, with join links, otherwise from meeting notes dated today), your commitments that are overdue or coming due, bills and documents due soon (from processed documents' due dates), and recent open questions. Turn on **Auto morning briefing** to have it open once on the first launch of each day, and set the **Briefing horizon** for how far ahead "coming due" looks.

## 1.22.0

### Added

- **YouTube folder setting.** Captured YouTube notes can go to their own folder (for example `Personal/YouTube`) instead of the output folder. Empty keeps the old behavior.

### Fixed

- **No more empty gap under the properties.** Capture notes (YouTube, dropped audio, imports) had a blank line between the Properties panel and the title; the heading now sits directly beneath it.

## 1.21.0

### Added

- **Document intelligence.** Right-click any image or PDF (or run *Process the active document*, or drop it in a watched inbox folder): its text is read (Text Extractor OCRs images; PDFs work out of the box), Claude classifies it and extracts the vendor, date, amount, currency, and due date, the file is renamed and filed under `Documents/<Type>/<year>/` (for example `Documents/Receipts/2026/2026-07-11 Costco 128.53.png`), and a note with those values as properties lands beside it, with the document embedded and its text folded below. Filed documents are queryable from Power Bases (sum your receipts by vendor) and findable through search and the assistant chat. Two new settings: **Documents folder** and **Documents inbox**.

## 1.20.0

### Added

- **The assistant remembers the conversation.** Closing the sidebar or reloading Obsidian no longer loses the chat: the conversation is stored (capped at the last 60 turns) and restored when the panel opens. New chat clears it.

## 1.19.0

### Added

- **The assistant sidebar.** A sparkles ribbon icon (or *Open assistant chat*) opens a running conversation in the right sidebar, grounded in your vault: each question retrieves the matching notes (through Power Explorer's shared index when installed, PDFs and OCR'd images included) and answers with clickable wiki-link citations. Short follow-ups keep the thread's subject. **Save summary** has Claude write the conversation up as a note in a Chats folder (title, findings with their links, follow-ups) with the full exchange folded underneath; **New chat** starts fresh. Saved chats are typed `capture-chat`, so digests, person pages, and the Meetings base ignore them.

## 1.18.0

### Changed

- **Renamed to Power Assistant.** The plugin outgrew "Capture": it preps meetings from your calendar, records and summarizes them, maintains person pages and weekly digests, answers questions about your notes, and exports recaps, with more assistant capabilities on the roadmap. New internal id `powerassistant`: install the new folder, copy your old `data.json` across (the deploy script does this for existing vaults), re-enable the plugin, and rebind any hotkeys. Existing notes, settings keys, and the sidebar view id are unchanged.

## 1.17.0

### Added

- **Person pages stay current.** Generated person pages now refresh automatically a few seconds after meeting notes change: delete a meeting and it disappears from everyone's hub (with counts and commitments recomputed), record or edit one and it shows up. Only pages carrying the `generated: true` property are touched, and only when their content actually changed; remove that property from a person page to take ownership of it and stop refreshes.

## 1.16.2

### Fixed

- **The actual cause of "Stop will not stop", found and fixed.** A dormant "Power Capture Live" sidebar tab, left over from versions before 1.10.0 (which opened that panel on every recording), is restored by Obsidian as a lightweight placeholder until first shown. The stop teardown blindly treated that placeholder as the live panel and called a method it does not have, crashing the teardown before the bar was removed, the microphone released, or the session cleared. Every stop path since 1.10.0 ran through that line, which is why stopping kept failing no matter what else was fixed. The lookup now verifies the panel is real, every teardown step is individually shielded so one failure can never block the rest, and a failing step names itself in the console.

## 1.16.1

### Fixed

- **No more zombie recording bars.** Reloading or updating the plugin mid-recording used to leave the floating bar (and the microphone) alive under a dead plugin instance, and its Stop button ran the old code forever. Unloading now tears down the bar, the recorder, and the audio streams completely (the crash-safe partial still recovers the audio on the next launch), and the bar also removes itself if it ever notices its session or owner is gone.
- **Second Stop click force-stops.** After you click Stop once, the button becomes "Force stop"; clicking it again releases the session immediately and recovers the audio, so "stopping…" can never hold you hostage.
- **Meeting rooms no longer imported as attendees** from the Microsoft 365 calendar (resource attendees are skipped, matching the `.ics` behavior). Rooms still appear as the location.

### Added

- **Show running version command.** Prints the build the RUNNING plugin was compiled from next to the version on disk, since the Community plugins list only shows what is on disk. Stop requests also log a state snapshot to the console for diagnosis.

## 1.16.0

### Added

- **From calendar… in the New meeting dialog.** Next to the paste buttons, a new button lists your upcoming Microsoft 365 meetings (searchable) and fills the open dialog with the one you pick: title, date, time, attendees, location, agenda, and the Teams join details. The same data as the bulk *Import meeting from calendar*, one meeting at a time, without leaving the dialog.

## 1.15.1

### Changed

- **Roomier Connect Microsoft 365 dialog.** The device code, the Copy code / Open sign-in page buttons, and the sign-in URL each get their own space instead of crowding together.

## 1.15.0

### Added

- **Clicking a missing person builds their hub.** Clicking an attendee whose person page does not exist yet no longer leaves a blank note: the page Obsidian creates is moved into the People folder and filled with that person's report (meetings, open commitments, decisions) automatically. This also rescues clicks from meeting notes created before 1.14.0, whose bare name links used to drop a blank page at the vault's default new-note location.

## 1.14.1

### Fixed

- **Microsoft 365 sign-in errors now tell you the fix.** The common first-connect failure (an app registered for "My organization only" with the Tenant field on `common`, which Microsoft rejects with AADSTS50059) now shows the actual remedy up front: paste the Directory (tenant) ID from the app's Overview page into the Tenant field. Wrong client ID, disabled public client flows, and missing consent get the same treatment. The Tenant setting text and the README setup steps now say to copy both IDs, since "My organization only" is the registration default.

## 1.14.0

### Added

- **People folder for attendee links.** Attendee names in a note's properties now link into a People folder (new **People folder** setting; empty uses People under the output folder), shown as just the name. Clicking a person who does not have a page yet creates it in that folder instead of the vault's default new-note location, and Person reports are written to the same folder, so the link and the hub are the same page. Old notes with bare name links keep working everywhere (reports, digests, redaction, exports, filters read both forms).

## 1.13.0

### Fixed

- **Stop can no longer hang, period.** A stop that does not finish within a few seconds now trips a watchdog that force-releases the session, and the audio captured so far is recovered immediately from the crash-safe partial file (still folding into the meeting note when the recording was started from one). Every step of the save itself is also time-limited, so a stalled disk write or a wedged encoder ends the recording with the audio kept instead of showing "stopping…" forever. If a force release ever happens, the console (Ctrl+Shift+I) records exactly which step timed out.

## 1.12.2

### Fixed

- **Stop always ends a recording, even one whose recorder died on its own.** If the recorder stopped unexpectedly mid-meeting (a codec hiccup, or the system-audio loopback track ending), the session could wedge: the on-page bar kept ticking over a recorder that was already dead, and Stop stuck on "stopping…" forever. Now a recording error ends the session by itself and saves whatever was captured up to that point, and Stop force-releases a session whose recorder is already gone instead of waiting for a part seam that never comes.

## 1.12.1

### Fixed

- **Stop now works on a paused recording.** Clicking Stop while a recording was paused (or otherwise not in the live "recording" state) showed "stopping…" but never stopped, because it waited for a rotation seam that never comes. Stop now ends the recorder in any active state.

## 1.12.0

### Changed

- **Redesigned the New meeting dialog** as a full-width form: a wider dialog with full-width Title, Attendees, and Agenda fields (the agenda box is now tall and resizable), and paste buttons that no longer crowd the fields. It scales down for smaller laptops.

### Added

- **Actual recorded time.** A recording folded into a meeting note now stamps its real wall-clock span (for example `recorded: "2:47 PM - 3:12 PM"`) as a property, which is handy for unscheduled meetings that have no invite time.

## 1.11.0

### Changed

- **Leaner note properties.** New meeting/capture notes no longer carry a redundant `type: capture` property; the `capture` tag identifies them instead. Existing notes keep working (identification falls back to the tag only when there is no type, so person reports and digests are still distinguished). Recreate the Meetings base (Create the Meetings base) to pick up notes that no longer carry a type.
- **Meeting time as a property.** A meeting created from an invite now records its time (for example "1:30 PM-2:30 PM") as a `time` property under the date.

## 1.10.0

### Changed

- **Recording controls moved onto the page.** While recording, a floating bar (pulsing dot, running timer, live level meter, Mark, and Stop) sits at the bottom of the note it belongs to. It shows only when that note is your active tab and hides when you switch away (the mic ribbon keeps pulsing so you know it is still recording). The sidebar panel now opens only for the AssemblyAI live streaming transcript.

## 1.9.2

### Fixed

- **No more `%%pc-progress%%` marker** showing while a meeting recording processes; the in-note indicator is matched by its own callout type instead of visible comments.
- **Meeting rooms are no longer added as attendees.** An Outlook invite's resource attendee (the conference room) is excluded from the attendee list; it is still captured as the location.
- **No stray blank line** between the properties and the title after a recording folds into a meeting note.

## 1.9.1

### Added

- **Stop button in the recording panel.** A clear "◼ Stop" button in the recording sidebar, so stopping no longer means clicking the mic ribbon again.

### Changed

- **No more toasts for meeting recordings.** The remaining "transcribing…" and "added the recording" toasts for the record-into-note flow are gone; the in-note progress indicator is the single source of status.
- **Clearer error messages.** API errors (like an out-of-credit Anthropic key) now show their human-readable message instead of raw JSON, both in the note and in notices.

## 1.9.0

### Changed

- **In-note progress instead of toasts for meeting recordings.** Recording into a meeting note now shows an inline "Power Capture" indicator with a spinning loader ("Transcribing the recording…", then "Writing the summary and action items…") right in the page. It is replaced by the finished summary and transcript when done, or a warning callout on failure, instead of a stack of black toast notifications.

## 1.8.2

### Added

- **Heads-up when recording with no transcription key.** Starting a recording while the selected provider has no API key now warns you right away (the audio is still saved). And if a recording meant for a meeting note can't be transcribed because no key is set, the note gets a warning saying so, instead of looking like nothing happened.

## 1.8.1

### Fixed

- **Record-into-note failures are now visible.** When a recording folded into a meeting note came back empty, or a transcription or extraction error occurred, the note was left unchanged with only a fleeting notice. It now appends a warning callout to the meeting note explaining what happened, and notes that the audio is saved and can be re-processed.

## 1.8.0

### Added

- **Deepgram as a transcription provider.** A third provider option alongside Whisper and AssemblyAI, with speaker labels and the same naming dialog. New accounts get a $200 free credit, so you can run hundreds of hours of meetings with speaker separation before paying anything. Pick it under Transcription > Provider, paste your key, and use **Test key** to confirm it works.

### Changed

- The AssemblyAI cost estimate now reflects current pricing (about $0.20/hour rather than the old $0.40), and the provider setting spells out the per-hour cost of each option.

## 1.7.1

### Added

- **Test key button for AssemblyAI.** In settings, after pasting your AssemblyAI key, click **Test key** to confirm it works before a real meeting. Switching the transcription provider to AssemblyAI gives you speaker labels (Speaker A / Speaker B) with a dialog to name them, and, on desktop with the recording panel on, a live streaming transcript.

## 1.7.0

### Added

- **Collapsible transcript.** The raw transcript is now tucked into a folded, collapsible callout by default, so a long transcript no longer dominates the note; click to expand it. The `## Transcript` heading stays in place, so Word export, re-extract, and speaker tagging are unaffected. Turn it off with the new **Collapse the transcript** setting.

## 1.6.1

### Fixed

- **Imported invites read clean.** A meeting note created from an invite is now tightly laid out (no blank line between the properties and the title, the when/where/join lines packed together), and the agenda's Outlook bullet glyphs (a filled dot, a hollow "o", a small square) become properly nested Markdown list items instead of stray characters and blank lines. The Teams meeting ID and passcode are also found even when they sit outside the invite's description.

## 1.6.0

### Added

- **Recording panel on every recording.** A sidebar now opens whenever you start recording, with a pulsing status, a running elapsed timer, and a live input-level meter, so you can always see that capture is working, on any transcription provider. On desktop with AssemblyAI it still streams the live transcript; on Whisper the panel notes that the full transcript appears after you stop. Controlled by the renamed **Recording panel** setting (previously "Live transcript while recording").

## 1.5.0

### Added

- **Prefill a meeting from an Outlook / Teams invite.** The New meeting dialog has a "Paste from Outlook" box (plus a one-click "From clipboard" button): paste an invite or a saved `.ics` and it fills the title, date, attendees, location, agenda, and the Teams join link, meeting ID, and passcode. Auto-detects `.ics` versus forwarded/body text, and fills whatever it can find.
- **Import straight from your Microsoft 365 calendar.** Connect once (Settings > Microsoft 365 calendar, using your own Azure app registration), then run *Import meeting from calendar* to see your next two weeks of meetings and pick which ones become notes. Sign-in uses the device-code flow in your browser, so your password never touches the plugin; tokens are stored locally in the vault. Each picked meeting becomes a dated, prefilled note you can record into.

## 1.4.0

### Added

- **Meeting notes: prep a page, then record into it.** A new *New meeting note* command and ribbon button open a dialog for a title, attendees, agenda, and meeting type, then create a dated note in a meetings folder of your choosing. Choose *Create and record* and the recording folds straight into that same page: your agenda stays on top, and the AI summary, action items, transcript, and audio land below it. A *Record a meeting into this note* command does the same for a meeting note you already have open. Two new settings: **Meetings folder** (empty uses the output folder) and **Meeting filename** (supports `{{date}}` and `{{title}}`).

## 1.3.0

### Added

- **Folder for recordings** setting. Empty keeps recordings in the capture folder (unchanged). When set (for example `_resources/audio`), recordings, their crash-safe partials, and recovered files land there instead; the folder is created on demand. Auto-processing and audio cleanup look in both the capture folder and the recordings folder, so recordings that predate the setting are still handled. Existing recordings are not moved.

## 1.2.0

### Added

- **Redaction for sharing/export.** Mask emails, phone numbers, SSNs, card numbers, custom terms, and optionally attendee names when you copy a summary or export to Word, the note itself is never modified. Includes a one-off *Copy redacted summary* command.
- **Custom meeting templates.** Define your own named section presets in settings; they appear in the Process and Re-extract dialogs alongside the built-ins.
- **Audio retention policy.** Keep recordings or automatically move them to trash after the note is written.
- **Pause / resume recording**, with timestamps that stay aligned to the gapless audio.

## 1.1.2

### Changed

- Word export now uses **Aptos** (the Microsoft 365 default body font) to match the reference, and its section headings are true **collapsible Heading 1** paragraphs, so Word shows expand/collapse controls per section.

## 1.1.1

### Changed

- **Word export restyled to match a professional recap template exactly**: Arial on a dark-gray body, a navy title with a blue participant line and gray italic date, navy headings each underlined with a thin blue rule, ▸ triangle bullets, and an Owner/Task/Deadline table with a navy header and light-gray gridlines. One-inch margins.

## 1.1.0

### Added

- **Export as Word document (.docx).** Right-click a capture note (or run the command) to produce a formatted Word recap (title block with attendees and the long date, styled section headings, and action items rendered as an Owner / Task / Deadline table) written to an Exports folder and opened in your default editor. Generated locally with the same `docx` library the commercial AI-notetaker tools use.

## 1.0.0

First stable release. This version is about trust: nothing you capture is lost, transient failures recover on their own, and the release is documented end to end.

### Reliability

- **Never lose a transcript.** If transcription succeeds but AI extraction fails (a rate limit, a network blip), the note is written anyway with the full transcript and a warning callout pointing at Re-extract. The transcript is forced in even if the run had it switched off, so paid-for transcription is never thrown away.
- **Automatic retry.** Transcription and extraction calls retry through transient failures (429 and 5xx) with exponential backoff; auth and client errors fail fast.
- **Size pre-flight.** Dropping a file larger than the 25 MB cloud Whisper limit gives a clear pointer to AssemblyAI or part rotation instead of a cryptic 413. Self-hosted and LAN endpoints are exempt.

### Added

- **Copy summary** command and right-click item: a capture distilled to the clipboard (title, speakers, sections) for pasting into Teams or email, transcript and embeds stripped.
- **Voice-memo attribution.** A solo recording is tagged as you (from the Your name setting).
- **Per-series section defaults.** The Process dialog can remember its section choices for a meeting's series; matching recordings auto-extract those same sections.
- **Auto weekly digest** (opt-in): the digest builds itself on the first launch of each week, quietly, if the week had meetings.

## 0.9.0, Meeting memory

- Import Otter (.txt) and Teams/Zoom (.vtt, .srt) transcripts into first-class capture notes, no transcription key needed.
- Person reports and 1:1 prep: open commitments, decisions, and meeting history per attendee, with a grounded agenda.
- Weekly digest with commitments-by-owner tables and stale-item aging.
- A ready-made Meetings base (Power Bases table + calendar).
- Re-extract a capture from its own transcript with a new template or model.
- Live copilot: on-demand catch-up and a running commitment detector.
- Per-note cost estimates; attendee and time-range filters on Ask.

## 0.8.0, Otter parity

- Talk-time shares with a Speakers line and a share-sorted naming dialog.
- Retroactive speaker tagging with suggestions from past attendees.
- Keywords extraction section.
- Ask about this meeting: a chat scoped to one capture with starter chips.

## 0.7.0, Meeting intelligence

- Clickable timestamps that seek the embedded audio.
- Speaker naming inferred from the transcript, confirmed in a dialog.
- Action items as Tasks-format checklist lines with owners and dates.
- Recurring-meeting awareness with carried-over items.
- Live transcript sidebar with Mark moment.
- Crash-safe recording with part rotation for long meetings.

## 0.6.0

- Timestamped speaker labels; shared search index with Power Explorer.

## 0.5.x

- Ask your vault (local BM25 index, cited answers); YouTube caption capture.

## 0.3.0, 0.2.0, 0.1.0

- Speaker diarization via AssemblyAI; system-audio call capture and the per-file processor; the original record/drop → transcribe → extract pipeline.
