# RV Notes

A phone-friendly app for keeping return visit notes. It works offline, and your notes are
kept in a Google Sheet you own.

- Add people with a name, address, map location, description, study status, available
  times, pictures, and when to return.
- Look someone up and add a visit with notes. Their visits are listed newest first.
- See who is due. People with a return date are listed first, soonest first, and overdue
  dates are shown in red.
- Keep track of your time (with a timer) and Bible studies each month, then send your
  monthly report from your phone's share menu. Past months' reports are kept.
- Works without internet. Everything is saved on your phone first and syncs with the
  spreadsheet when you're back online.
- Connect more than one spreadsheet (for example "Chris' RVs" and "Stacey's RVs") and
  switch between them.

## How it fits together

| Part | Where it lives | What it does |
| --- | --- | --- |
| The app (`index.html`, `js/`, `styles.css`, `sw.js`, …) | GitHub Pages: https://westc.github.io/rv-notes/ | The screens you use. It's a Progressive Web App, so it can be added to your home screen and opened without internet. One copy serves everyone. |
| The backend (`apps-script/Code.gs`) | An Apps Script attached to each person's spreadsheet | Saves and reads the spreadsheet. It only answers requests that include the spreadsheet's secret key. |
| The data | The Google Sheet | One row per person, visit, picture, time entry, study, and monthly report. |

GitHub only hosts the app's files. Your notes go straight from your phone to your
spreadsheet and never pass through GitHub.

## Set up a spreadsheet

Each person who wants their own RV list does this once.

1. Create a new Google Sheet, for example **Chris' RVs**.
2. Open **Extensions → Apps Script**.
3. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs).
   You don't need any HTML files.
4. Click **Deploy → New deployment**, choose **Web app**, and set:
   - **Execute as:** Me
   - **Who has access:** Anyone
5. Click **Deploy** and approve the permissions. Copy the **Web app URL** (it ends in
   `/exec`).
6. Back in the spreadsheet, reload the page. Choose **RV Notes → Connect app** (on a
   computer, since Sheets on phones doesn't show custom menus), and paste the web app URL
   if it isn't filled in already.
7. On your phone, open https://westc.github.io/rv-notes/ and add it to your home screen
   (iPhone Safari: **Share → Add to Home Screen**. Android Chrome: **⋮ → Add to Home
   screen** or **Install app**). Open RV Notes from the home screen, tap **Scan QR code**,
   and point the camera at the code in the dialog. Then tap **Connect**.

   Install before connecting: on iPhone and iPad, the Home Screen app keeps its data
   separate from Safari. You can also copy the link in the dialog, send it to yourself,
   and use **Paste a link**.

To add another spreadsheet (for example your spouse's), tap the spreadsheet name at the top
of the list, then **Add a spreadsheet**.

### Why "Anyone" is safe here

The app is on a different website (GitHub Pages) than the script, and browsers don't send
Google sign-in cookies along with those requests. So the web app has to accept requests
from anyone, and the spreadsheet's **secret key** is what keeps others out:

- Every request must include the key. Requests without it get nothing.
- The key is only shown in **RV Notes → Connect app**, which only people who can edit the
  spreadsheet can open. It's stored in the script's properties, not in the sheet.
- Even with the key, someone can only use the app's own actions (read and change RVs,
  visits, and pictures, and look up addresses) on **this** spreadsheet. The script uses
  `@OnlyCurrentDoc`, so it can't touch your other files, and it has no access to your
  email or account.
- The key travels in the body of each request, never in a URL. In the connect link it's
  after the `#`, which browsers never send to any server, and the app removes it from the
  address bar right away.
- **RV Notes → Reset key** makes a new key. Every device stops syncing until it connects
  with the new link (changes not yet synced are kept until then). Use it if a phone is
  lost or a link was shared by mistake.

The app also protects the keys saved on your phone. All of its code and libraries are
served from this repository (no CDNs), and a Content Security Policy blocks scripts from
anywhere else and only lets the app talk to Google Apps Script and the OpenStreetMap tile
server. Turn on two-factor authentication for the GitHub account that hosts the app, since
whoever controls the repository controls the app's code.

### Permissions the script asks for

- **See, edit, create, and delete this spreadsheet** (`@OnlyCurrentDoc` limits it to this
  one file).
- **Connect to an external service**, used only to open Google Maps share links (such as
  `https://maps.app.goo.gl/…`) to find the location in them. It only fetches Google
  addresses.
- Address searches use Apps Script's built-in Maps service, which needs no API key. Free
  Google accounts can do about 1,000 searches a day.

### Updating the script

After pasting a new `Code.gs`, use **Deploy → Manage deployments → Edit (pencil) →
Version: New version → Deploy** so the same URL serves the new code. The URL and key stay
the same, so devices keep syncing.

If the app is newer than a spreadsheet's script (for example, time and reports were added
but the script wasn't updated yet), RVs and visits keep syncing. Time, studies, and reports
are kept on the device, with a notice asking you to update the script, and they sync as
soon as it is.

## Using the app

- **Syncing.** The cloud icon at the top of the list shows the sync status. Tap it to sync
  now. The app also syncs when it opens, when you come back online, a moment after each
  change, and every few minutes while it's open. "3 changes waiting" means they're saved on
  this phone and will be sent next time it can reach the spreadsheet.
- **Offline.** Everything works offline except address and Google Maps link searches.
  "Use my location" still works because GPS doesn't need internet. Maps only show areas you
  viewed before while online. OpenStreetMap doesn't allow downloading whole areas ahead of
  time.
- **Two devices, same person.** If the same RV is edited on two devices before they sync,
  the later edit wins. Deleting always wins.
- **Spreadsheets.** Tap the spreadsheet name at the top of the list to switch, rename,
  remove one from this device, or download everything again. Removing one only deletes the
  copy on this device.
- **Updates.** When a new version of the app is published, a **Reload** banner appears.
- **Monthly report.** Tap the clipboard icon at the top of the list. Pick the month with the arrows,
  or tap one under **Months** (a check mark means it was sent).
  - **Calendar.** Each day shows its time (green for ministry, blue for credit; a dot means
    both). Tap a day to see its entries, then **Add** to log time on that day. Tap an
    entry to change or delete it.
  - **Time.** **Add** logs a date, hours and minutes, ministry or credit time, and
    an optional note. **Start timer** keeps running even if you close the app. **Stop**
    fills in the time for you to save.
  - **Hours** are whole hours. Leftover minutes carry into the next month, and the screen
    shows how many came in and how many carry forward. Credit hours are counted and
    carried separately.
  - **Bible studies.** Tap an RV marked Studying to count them, pick another RV, or type
    someone else's name. You can also count a study from an RV's page (**Count as a study
    in …**) or when saving a visit (**Bible study**, checked automatically for RVs marked
    Studying). Each person counts once per month, even if added on two phones.
  - **Shared in the ministry** is **Yes** automatically once you log time, a visit, or a
    study that month. Choose **Yes** or **No** to set it yourself.
  - **Send report** opens your phone's share menu with the report text, so you can pick
    Messages, WhatsApp, email, and so on. Once it's shared, the month is marked as sent,
    and what was sent is saved. If you change the month later, the app says so and offers
    **Send again**. Minutes carried into the next month come from what was sent.
- **List.** Search matches names, addresses, descriptions, and available times. Filters:
  **Due** (return date today or earlier), **Upcoming**, and **Studies**.
- **Person.** Shows a map, **Open in Maps** and **Directions** links (they use the
  coordinates if there are any, otherwise the address), availability, the description,
  pictures (tap one to view it full screen), and visits, newest first.
- **Location.** Type coordinates, tap the crosshair to use your current location, or tap
  the map button and then tap the map to drop a pin. You can drag the pin to adjust it.
  The map also has a search box (it starts with the person's address). Type an address
  or paste a Google Maps link (in Google Maps, tap the place, then **Share → Copy link**).
  The match shows up as an orange dot. If there are several matches, tap one to see it.
  Tap **Use this spot** to move the pin there. If the Address field is empty, it's filled
  in with the match's address.
- **Pictures.** **Take photo** opens the camera. **Choose photos** picks from your library.
- **Available times.** Tap the cells in the 7 × 3 grid. Tap a day or a period heading to
  toggle the whole row or column.
- **New Visit.** Starts with the current date and time. The **Next return visit** field
  starts with the person's current Return At (if it's in the future) and is saved back to
  the person. Leave it blank to clear it. **+1 week**, **+2 weeks**, and **+4 weeks** count
  from the visit's start time.
- **Drafts.** Once you've typed notes for a new visit, they're kept on this device until
  you save or discard them, even if you leave the page.
- **Markdown.** Descriptions and notes support Markdown. Use the **Preview** tab to check
  how they'll look. Links open in a new tab.
- **Deleting** a person also deletes their visits and pictures.

## How the data is stored

Each sheet's first row holds the headers. Columns are found by header name, so you can
reorder them or add your own columns, even between the app's columns. The app only writes
its own columns. If you delete one of the app's headers, it is added back at the end.

### RVs

| Column | Contents |
| --- | --- |
| ID | Made by the app (a UUID). |
| Name | Required. |
| Address | Free text, can span several lines. |
| Coordinates | `latitude, longitude` with 6 decimal places, e.g. `35.046900, -85.309700`. You can paste this into Google Maps, Apple Maps, and most other map apps. |
| Description | Markdown. |
| Created At | When the person was first added. |
| Is Study | Checkbox. |
| Available Times | Comma-separated `Day Period` values, e.g. `Mon Evening, Sat Morning`. Periods are Morning, Afternoon, and Evening. |
| Pictures | Comma-separated IDs of rows in the **Pictures** sheet, in display order. |
| Return At | Date and time of the next planned visit (optional). |
| Updated At | When the person was last changed, on whichever device changed it. Decides which edit wins. |
| Synced At | When the spreadsheet received the change. Devices ask for everything synced since their last sync. |

### Visits

| Column | Contents |
| --- | --- |
| ID | Made by the app. |
| Person ID | The **ID** of the person in **RVs**. |
| Created At | When the visit started. It defaults to when you opened the New Visit form, and you can change it. |
| Notes | Markdown. |
| Updated At, Synced At | As in **RVs**. |

### Pictures

| Column | Contents |
| --- | --- |
| ID | Made by the app and listed in the person's **Pictures** cell. |
| Person ID | Who the picture belongs to, so it's deleted along with them. |
| Created At | When it was uploaded. |
| Mime Type | Usually `image/jpeg`. |
| Bytes | Size of the image. |
| Data 1 … Data 4 | The image as base64, split into pieces of up to 45,000 characters. A cell can hold 50,000 characters at most, and a 120 KB image is about 164,000 characters of base64. |

Pictures are capped at **120 KB**. Before saving, the app re-encodes each photo as a JPEG
and lowers the quality, then the size, until it fits. A typical phone photo ends up around
1200–1600 pixels on its longest side. The script rejects anything over the limit.

Large picture cells make the **Pictures** sheet slow to scroll. You can hide that sheet
(right-click the tab → **Hide sheet**). The app still works with it hidden.

### Time

| Column | Contents |
| --- | --- |
| ID | Made by the app. |
| Date | `yyyy-mm-dd` (text, so it never shifts with time zones). |
| Minutes | Whole minutes, 1 to 1,440. |
| Kind | `service` or `credit`. |
| Note | Optional. |
| Updated At, Synced At | As in **RVs**. |

### Studies

One row per Bible study counted in a month.

| Column | Contents |
| --- | --- |
| ID | Made by the app. |
| Month | `yyyy-mm`. |
| Person ID | The RV, if the study is one. Empty for a name you typed. |
| Name | The study's name, kept even if the RV is deleted later. |
| Updated At, Synced At | As in **RVs**. |

### Reports

One row per month (ID `report-yyyy-mm`), made once you change something on that month's
report or send it.

| Column | Contents |
| --- | --- |
| Month | `yyyy-mm`. |
| Shared | `yes`, `no`, or empty for automatic. |
| Comments | The comments line. |
| Sent At | When it was last sent. Empty if it hasn't been. |
| Hours, Credit Hours, Studies | What was sent. |
| Carried Minutes, Carried Credit Minutes | Leftover minutes carried into the next month when it was sent. |
| Report Text | The exact text that was sent. |
| Updated At, Synced At | As in **RVs**. |

### Deleted

One row per deleted person, visit, time entry, or study (**ID**, **Table**, **Deleted At**, **Synced At**), so
other devices find out about deletions the next time they sync. Don't delete these rows
unless every device has synced since.

### Editing the sheet by hand

You can edit cells directly. Rows you add by hand need an **ID** (any 8–64 letters,
numbers, or dashes) to show up in the app. Edits to existing rows reach devices the next
time they download everything again (**Spreadsheets → Download … again**), because hand
edits don't update **Synced At**. Clearing a row's **Synced At** cell makes it sync on the
next regular sync.

## Limits and notes

- A text cell holds at most 50,000 characters, so that's the limit for a description or a
  visit's notes.
- Saves on the script take a lock, so two devices syncing at once can't overwrite each
  other.
- Text is saved with a leading apostrophe so Sheets keeps it exactly as typed. Without it,
  a name like `=Bob` would turn into a formula and an address like `10-12` into a date.
  The apostrophe doesn't show up in the cell.
- Times are entered in the phone's local time zone and stored as real date values, shown
  in the spreadsheet's time zone (**File → Settings**).
- Map tiles come from OpenStreetMap's public tile server, which is fine for personal use.
  The app keeps up to about 3,000 viewed tiles on the device.
- The app asks the browser to keep its data even when storage runs low. On iPhone, data
  for websites you haven't opened in a while can be cleared, but not for apps added to the
  Home Screen, which is another reason to install it.

## Development

The app has no build step for its JavaScript. `npm run build` only refreshes generated
files, which are committed so GitHub Pages can serve the repository as is.

```sh
npm install
npm test           # runs Code.gs against fake Sheets in Node
npm run serve      # the app plus a fake backend on http://localhost:8787
npm run build      # vendor libraries, icons, Tailwind CSS, and sw.js
```

| Command | What it does |
| --- | --- |
| `npm run vendor` | Copies Vue, Leaflet, marked, DOMPurify, Bootstrap Icons, and jsQR from `node_modules` into `vendor/`. |
| `npm run icons` | Draws the PNG icons in `icons/`. |
| `npm run css` | Builds `styles.css` from `src/styles.css` with Tailwind. Run it after adding classes. |
| `npm run stamp` | Lists the app's files in `sw.js` and sets its version. **Run it before every commit that changes the app**, or devices won't get the update. |

`npm run serve` prints a connect link for a local test spreadsheet and a second one for
trying more than one connection. `POST /__offline?on=1` makes the server drop every
request so you can try the app offline (`?on=0` to undo).

### Publishing

The repository is served by GitHub Pages from the `main` branch's root. Pushing to `main`
publishes the app, and devices offer to reload the next time they open it.

If you host it somewhere else, update `APP_URL` at the top of `apps-script/Code.gs`.
