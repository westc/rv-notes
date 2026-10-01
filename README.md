# RV Notes

A phone-friendly Google Apps Script web app for keeping return visit notes. Everything is
stored in the Google Sheet the script is attached to, including pictures.

- Add people with a name, address, map location, description, study status, available
  times, pictures, and when to return.
- Look someone up and add a visit with notes. Their visits are listed newest first.
- See who is due. People with a return date are listed first, soonest first, and overdue
  dates are shown in red.

Built with Vue 3, Tailwind CSS, Leaflet with OpenStreetMap maps, and Markdown rendered by
marked and sanitized by DOMPurify. All of these load from CDNs, so there's no build step.

## Files

| File | Purpose |
| --- | --- |
| `Code.gs` | Server side: reads and writes the sheets. |
| `Index.html` | The whole web app (HTML, CSS, and JavaScript). |

## Installation

1. Create a new Google Sheet, for example **RV Notes**.
2. Open **Extensions → Apps Script**.
3. Replace the contents of `Code.gs` with this project's `Code.gs`.
4. Add an HTML file named `Index` (**+ → HTML**) and paste in `Index.html`.
5. Click **Deploy → New deployment**, choose **Web app**, and set:
   - **Execute as:** Me
   - **Who has access:** Only myself (see [Access](#access) for other options)
6. Click **Deploy**, approve the permissions, and open the **Web app URL**.

The **RVs**, **Visits**, and **Pictures** sheets are created the first time the web app
opens. You can also create them from the spreadsheet with **RV Notes → Set Up Sheets**.
Reload the spreadsheet first if that menu doesn't appear yet.

After you change the code, use **Deploy → Manage deployments → Edit (pencil) → Version:
New version → Deploy** so the same URL serves the new code.

### Permissions

The script uses `@OnlyCurrentDoc`, so it asks only for access to **this** spreadsheet,
not all of your Google Drive files. It also asks to **connect to an external service**,
which it uses only to open Google Maps share links (such as `https://maps.app.goo.gl/…`)
to find the location in them. Address searches use Apps Script's built-in Maps service.

### Open it on your phone

Open the web app URL in your phone's browser and add it to your home screen (Safari:
**Share → Add to Home Screen**. Chrome: **⋮ → Add to Home screen**). In the spreadsheet,
**RV Notes → Open Web App** shows the link once the web app has been opened at least once.

## Embedding in Google Sites

1. In Google Sites, open the **Pages** panel, click **+**, and choose **Full page embed**.
   Or, on an existing page, use **Insert → Embed → By URL**.
2. Paste the web app URL (the one ending in `/exec`).

`Code.gs` allows the app to be framed (`XFrameOptionsMode.ALLOWALL`).

Some browsers limit embedded apps, Safari on iPhone in particular, because they block
third-party cookies and storage. You might see a Google sign-in loop, "Use my location"
might not work, or visit drafts might not be kept. Opening the `/exec` URL directly (or
from a home screen shortcut) avoids all of these.

## Access

Your notes contain personal details about other people, so keep the deployment private.

| Goal | Execute as | Who has access |
| --- | --- | --- |
| Only you (recommended) | Me | Only myself |
| You and the people you share the spreadsheet with | User accessing the web app | Anyone with Google account (or Anyone within your domain) |

With **User accessing the web app**, the script runs as each visitor. Each visitor
approves the permissions the first time, and Google Sheets only lets them save if they can
edit the spreadsheet. Don't combine **Execute as: Me** with **Anyone**: that would let
anyone who has the link read and change your notes.

## How the data is stored

Each sheet's first row holds the headers. Columns are found by header name, so you can
reorder them or add your own columns (the app leaves extra columns alone). If you delete
one of the app's headers, it is added back at the end.

### RVs

| Column | Contents |
| --- | --- |
| ID | Generated automatically (a UUID). |
| Name | Required. |
| Address | Free text, can span several lines. |
| Coordinates | `latitude, longitude` with 6 decimal places, e.g. `35.046900, -85.309700`. You can paste this into Google Maps, Apple Maps, and most other map apps. |
| Description | Markdown. |
| Created At | Set automatically when the person is first saved. |
| Is Study | Checkbox. |
| Available Times | Comma-separated `Day Period` values, e.g. `Mon Evening, Sat Morning`. Periods are Morning, Afternoon, and Evening. |
| Pictures | Comma-separated IDs of rows in the **Pictures** sheet, in display order. |
| Return At | Date and time of the next planned visit (optional). |

### Visits

| Column | Contents |
| --- | --- |
| ID | Generated automatically. Lets a visit be edited or deleted. |
| Person ID | The **ID** of the person in **RVs**. |
| Created At | When the visit started. It defaults to when you opened the New Visit form, and you can change it. |
| Notes | Markdown. |

### Pictures

| Column | Contents |
| --- | --- |
| ID | Generated automatically and listed in the person's **Pictures** cell. |
| Person ID | Who the picture belongs to, so it's deleted along with them. |
| Created At | When it was uploaded. |
| Mime Type | Usually `image/jpeg`. |
| Bytes | Size of the image. |
| Data 1 … Data 4 | The image as base64, split into pieces of up to 45,000 characters. A cell can hold 50,000 characters at most, and a 120 KB image is about 164,000 characters of base64. |

Pictures are capped at **120 KB**. Before uploading, the app re-encodes each photo as a
JPEG and lowers the quality, then the size, until it fits. A typical phone photo ends up
around 1200–1600 pixels on its longest side. The server rejects anything over the limit.

Large picture cells make the **Pictures** sheet slow to scroll. You can hide that sheet
(right-click the tab → **Hide sheet**). The app still works with it hidden.

## Using the app

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

## Limits and notes

- A text cell holds at most 50,000 characters, so that's the limit for a description or a
  visit's notes.
- All saves take a script lock, so two quick saves can't overwrite each other.
- Text is saved with a leading apostrophe so Sheets keeps it exactly as typed. Without it,
  a name like `=Bob` would turn into a formula and an address like `10-12` into a date.
  The apostrophe doesn't show up in the cell.
- Times are entered in the phone's local time zone and stored as real date values, shown
  in the spreadsheet's time zone (**File → Settings**).
- Map tiles come from OpenStreetMap's public tile server, which is fine for personal use.
