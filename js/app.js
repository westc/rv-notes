import { createApp, ref, reactive, computed, watch, nextTick } from '../vendor/vue.esm-browser.prod.js';
import * as L from '../vendor/leaflet/leaflet-src.esm.js';
import { callApi } from './api.js';
import { i18n, LANGUAGE_NAMES, setLanguage, t } from './i18n.js';
import { calendarFile, googleCalendarUrl, pdfFileName, personPdf, shareOrDownload } from './share.js';
import { createStore } from './store.js';
import {
  addMonths, calendarCells, clockMinutes, dayKey, formatMinutes, monthKey, monthLabel, reportId, reportMonths,
  reportText, summarize, uniqueStudies, weekStart, weekdayLabels
} from './report.js';
import { startScanner } from './scanner.js';
import {
  DAYS, PERIODS, MAX_PICTURE_BYTES, markdown, storage, decodeBase64Url, toLocalInput, fromLocalInput,
  formatDateTime, shortDate, relative, endOfToday, returnBadgeClass, firstLine, parseCoords, formatCoords,
  mapQuery, mapsUrl, directionsUrl, shrinkImage, uuid, nowIso, cleanTag, markdownToText,
  MAX_PHONES, isPhoneNumber, telUrl, smsUrl, whatsAppUrl
} from './util.js';

const isLocalDev = ['localhost', '127.0.0.1'].includes(location.hostname);
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function addTiles(map) {
  // Leaflet's own credit link would open over the whole app.
  map.attributionControl.setPrefix(false);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    // Lets the service worker keep viewed tiles for offline use.
    crossOrigin: true,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
  }).addTo(map);
}

function changesWaiting(count) {
  return t('sync.waiting', { count });
}

function isBackendUrl(url) {
  return /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec$/.test(url) ||
    (isLocalDev && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/s\/[\w-]+)?\/exec$/.test(url));
}

/**
 * Reads a link made by RV Notes → Connect app in the spreadsheet:
 * <app URL>#connect=<base64url of {"u": web app URL, "k": key, "n": name}>.
 *
 * @returns {?{url: string, key: string, name: string}}
 */
function parseConnectLink(text) {
  const match = /#connect=([A-Za-z0-9_-]+)/.exec(text || '');
  if (!match) return null;
  try {
    const data = JSON.parse(decodeBase64Url(match[1]));
    const url = String(data.u || '');
    const key = String(data.k || '');
    if (!isBackendUrl(url) || !/^[A-Za-z0-9]{32,128}$/.test(key)) return null;
    return { url, key, name: String(data.n || '').trim().slice(0, 100) };
  } catch (err) {
    return null;
  }
}

/* -------------------------------------------------------------------- */
/* Markdown editor                                                      */
/* -------------------------------------------------------------------- */

const MdEditor = {
  props: {
    modelValue: { type: String, default: '' },
    placeholder: String,
    rows: { type: Number, default: 6 }
  },
  emits: ['update:modelValue'],
  setup() {
    return { preview: ref(false), markdown, t };
  },
  template: `
    <div class="overflow-hidden rounded-lg ring-1 ring-slate-300 focus-within:ring-2 focus-within:ring-indigo-500 dark:ring-slate-600">
      <div class="flex items-center border-b border-slate-200 bg-slate-50 text-sm dark:border-slate-700 dark:bg-slate-800">
        <button type="button" class="px-3 py-2" :class="preview ? 'text-slate-500' : 'font-semibold text-indigo-600 dark:text-indigo-400'" @click="preview = false">{{ t('md.write') }}</button>
        <button type="button" class="px-3 py-2" :class="preview ? 'font-semibold text-indigo-600 dark:text-indigo-400' : 'text-slate-500'" @click="preview = true">{{ t('md.preview') }}</button>
        <a class="ml-auto px-3 py-2 text-xs text-slate-500" href="https://www.markdownguide.org/basic-syntax/" target="_blank" rel="noopener">{{ t('md.help') }}</a>
      </div>
      <textarea v-if="!preview" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)"
        :rows="rows" :placeholder="placeholder"
        class="block w-full resize-y border-0 bg-white p-3 text-base focus:outline-none focus:ring-0 dark:bg-slate-900"></textarea>
      <div v-else class="prose prose-sm min-h-[8rem] max-w-none bg-white p-3 dark:prose-invert dark:bg-slate-900">
        <div v-if="modelValue" v-html="markdown(modelValue)"></div>
        <p v-else class="italic text-slate-400">{{ t('md.empty') }}</p>
      </div>
    </div>`
};

/* -------------------------------------------------------------------- */
/* App                                                                  */
/* -------------------------------------------------------------------- */

const store = createStore();

const app = createApp({
  setup() {
    const days = DAYS;
    const periods = PERIODS;
    const maxPictureBytes = MAX_PICTURE_BYTES;

    const view = ref('loading');
    const busy = ref('');
    const toast = ref(null);
    const search = ref('');
    const filter = ref('all');
    const currentId = ref('');
    const lightbox = ref(null);
    const now = ref(new Date());
    // store.state.pictures is replaced when another spreadsheet is opened.
    const pictureCache = computed(() => store.state.pictures);

    // Plain-text previews of visit notes, kept until the notes change.
    const notePreviews = new Map();
    function notesPreview(visit) {
      const key = `${visit.id}|${visit.updatedAt}`;
      if (!notePreviews.has(key)) notePreviews.set(key, markdownToText(visit.notes).replace(/\s+/g, ' ').slice(0, 300));
      return notePreviews.get(key);
    }

    // People with how many visits they have, when the latest one was, and its
    // notes.
    const people = computed(() => {
      const stats = {};
      store.state.visits.forEach(visit => {
        const stat = stats[visit.personId] || (stats[visit.personId] = { count: 0, last: null });
        stat.count++;
        if (!stat.last || visit.createdAt > stat.last.createdAt) stat.last = visit;
      });
      return store.state.people.map(person => {
        const stat = stats[person.id];
        return {
          ...person,
          tags: person.tags || [],
          phones: person.phones || [],
          visitCount: stat ? stat.count : 0,
          lastVisitAt: stat ? stat.last.createdAt : '',
          lastNotes: stat ? notesPreview(stat.last) : ''
        };
      });
    });

    /* Language */

    const language = computed(() => i18n.choice);
    const languages = computed(() => [
      { code: '', name: t('settings.automatic') },
      ...Object.entries(LANGUAGE_NAMES).map(([code, name]) => ({ code, name }))
    ]);
    function changeLanguage(choice) {
      setLanguage(choice);
    }

    const current = computed(() => people.value.find(person => person.id === currentId.value) || null);

    const visits = computed(() => store.state.visits
      .filter(visit => visit.personId === currentId.value)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));

    let toastTimer = null;
    function showToast(message, error) {
      clearTimeout(toastTimer);
      toast.value = { message, error: !!error };
      toastTimer = setTimeout(() => toast.value = null, error ? 8000 : 3000);
    }
    function showError(err) {
      showToast(err && err.message ? err.message : String(err), true);
    }

    async function run(message, task) {
      busy.value = message;
      try {
        return await task();
      } catch (err) {
        showError(err);
        throw err;
      } finally {
        busy.value = '';
      }
    }

    function show(name) {
      view.value = name;
      window.scrollTo(0, 0);
    }

    store.onRejected(rejected => {
      const first = rejected[0];
      showToast(rejected.length === 1
        ? t('sync.rejectedOne', { error: first.error })
        : t('sync.rejectedMany', { count: rejected.length, error: first.error }), true);
    });

    /* -- Syncing -------------------------------------------------------- */

    function autoSync() {
      if (store.state.active) store.sync().catch(() => {});
    }

    async function syncNow() {
      if (store.state.status === 'syncing') return;
      try {
        await store.sync();
        showToast(t('sync.done'));
      } catch (err) {
        showError(err);
      }
    }

    const syncIcon = computed(() => {
      const { status, pending } = store.state;
      if (status === 'syncing') return { icon: 'bi-arrow-repeat inline-block animate-spin', label: t('sync.icon.syncing') };
      if (status === 'auth') return { icon: 'bi-key', color: 'text-red-600 dark:text-red-400', label: t('sync.icon.auth') };
      if (status === 'error') return { icon: 'bi-exclamation-triangle', color: 'text-amber-600 dark:text-amber-400', label: t('sync.icon.error') };
      if (status === 'offline') return { icon: 'bi-cloud-slash', label: t('sync.icon.offline') };
      return { icon: pending ? 'bi-cloud-arrow-up' : 'bi-cloud-check', label: t('sync.icon.now') };
    });

    const syncSummary = computed(() => {
      const { status, pending, active } = store.state;
      if (status === 'syncing') return t('sync.syncing');
      if (status === 'offline') return pending ? t('sync.offlineWaiting', { waiting: changesWaiting(pending) }) : t('sync.offline');
      if (status === 'auth') return t('sync.auth');
      if (status === 'error') return t('sync.error');
      if (pending) return changesWaiting(pending);
      return active && active.lastSyncAt ? t('sync.synced', { when: relative(active.lastSyncAt, now.value) }) : '';
    });

    window.addEventListener('online', autoSync);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      now.value = new Date();
      autoSync();
      if (registration) registration.update().catch(() => {});
    });
    setInterval(() => {
      now.value = new Date();
      const active = store.state.active;
      const stale = active && (!active.lastSyncAt || Date.now() - new Date(active.lastSyncAt) > 5 * 60000);
      if (document.visibilityState === 'visible' && (stale || store.state.pending)) autoSync();
    }, 30000);

    /* -- App updates and installing ---------------------------------------- */

    const updateReady = ref(null);
    let registration = null;
    let reloading = false;

    async function registerServiceWorker() {
      if (!('serviceWorker' in navigator)) return;
      try {
        registration = await navigator.serviceWorker.register('sw.js');
      } catch (err) {
        console.warn('Offline support is unavailable:', err);
        return;
      }
      const track = worker => worker && worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) updateReady.value = worker;
      });
      if (registration.waiting && navigator.serviceWorker.controller) updateReady.value = registration.waiting;
      track(registration.installing);
      registration.addEventListener('updatefound', () => track(registration.installing));
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) location.reload();
      });
    }

    function applyUpdate() {
      if (view.value === 'editPerson' && formState() !== formSnapshot && !confirm(t('notice.discardReload'))) return;
      reloading = true;
      updateReady.value.postMessage('skipWaiting');
    }

    const showInstallTip = ref(!isStandalone && !storage.get('rv-notes/installTipDismissed'));
    function dismissInstallTip() {
      showInstallTip.value = false;
      storage.set('rv-notes/installTipDismissed', true);
    }

    /* -- Spreadsheets (connections) -------------------------------------- */

    const connectForm = reactive({ link: '', name: '' });
    const connectLink = computed(() => parseConnectLink(connectForm.link));
    const connectExisting = computed(() =>
      connectLink.value && store.state.connections.find(c => c.url === connectLink.value.url) || null);
    const pendingCounts = reactive({});

    watch(connectLink, link => {
      if (link && !connectForm.name.trim()) {
        connectForm.name = connectExisting.value ? connectExisting.value.name : link.name;
      }
    });

    function startAddConnection() {
      connectForm.link = '';
      connectForm.name = '';
      show('addConnection');
    }

    async function openConnections() {
      show('connections');
      for (const c of store.state.connections) pendingCounts[c.id] = await store.pendingCount(c.id);
    }

    function resetView() {
      currentId.value = '';
      search.value = '';
      filter.value = 'all';
    }

    async function saveConnectionForm() {
      const link = connectLink.value;
      if (!link) return;
      const name = connectForm.name.trim() || link.name || t('connect.defaultName');
      const existing = connectExisting.value;
      busy.value = t('connect.checking');
      try {
        await callApi(link, 'info');
      } catch (err) {
        busy.value = '';
        if (err.code !== 'network') {
          showError(err);
          return;
        }
        if (!confirm(t('connect.addAnyway', { error: err.message }))) return;
      }
      busy.value = '';
      if (existing) {
        await store.updateConnection(existing.id, { key: link.key, name });
        await store.switchTo(existing.id);
      } else {
        await store.addConnection({ name, url: link.url, key: link.key });
      }
      connectForm.link = '';
      connectForm.name = '';
      // Asks the browser not to clear this device's copy when space runs low.
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      resetView();
      show('list');
      showToast(t(existing ? 'connect.reconnected' : 'connect.connected', { name }));
      autoSync();
    }

    async function switchConnection(id) {
      await store.switchTo(id);
      resetView();
      show('list');
      autoSync();
    }

    async function renameConnection(connection) {
      const name = prompt(t('connect.name'), connection.name);
      if (name && name.trim()) await store.updateConnection(connection.id, { name: name.trim() });
    }

    async function removeConnection(connection) {
      const waiting = await store.pendingCount(connection.id);
      const warning = waiting ? `\n\n${t('connections.removeWarning', { count: waiting })}` : '';
      if (!confirm(t('connections.removeConfirm', { name: connection.name }) + warning)) return;
      await store.removeConnection(connection.id);
      delete pendingCounts[connection.id];
      if (!store.state.connections.length) show('welcome');
      showToast(t('connections.removed', { name: connection.name }));
    }

    function redownload() {
      run(t('connections.downloading'), () => store.redownload())
        .then(() => showToast(t('connections.redownloaded')))
        .catch(() => {});
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        showToast(t('copy.done'));
      } catch (err) {
        showToast(t('copy.failed'), true);
      }
    }

    /* -- List ------------------------------------------------------------ */

    const matchesFilter = {
      all: () => true,
      due: person => person.returnAt && new Date(person.returnAt) < endOfToday(),
      upcoming: person => person.returnAt && new Date(person.returnAt) >= endOfToday(),
      study: person => person.isStudy
    };

    const filters = computed(() => [
      { key: 'all', label: t('filter.all') },
      { key: 'due', label: t('filter.due') },
      { key: 'upcoming', label: t('filter.upcoming') },
      { key: 'study', label: t('filter.studies') }
    ].map(f => ({ ...f, count: people.value.filter(matchesFilter[f.key]).length })));

    // People with a return date come first (soonest first), then everyone
    // else by most recent activity.
    function comparePeople(a, b) {
      if (a.returnAt && b.returnAt) return a.returnAt.localeCompare(b.returnAt);
      if (a.returnAt || b.returnAt) return a.returnAt ? -1 : 1;
      return (b.lastVisitAt || b.createdAt).localeCompare(a.lastVisitAt || a.createdAt);
    }

    // Every tag in use, alphabetically, for filtering and suggestions.
    const allTags = computed(() => {
      const tags = new Map();
      people.value.forEach(person => person.tags.forEach(tag => {
        if (!tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
      }));
      return [...tags.values()].sort((a, b) => a.localeCompare(b, i18n.locale, { sensitivity: 'base' }));
    });
    const tagFilter = ref('');

    const filteredPeople = computed(() => {
      const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      const tag = tagFilter.value.toLowerCase();
      return people.value
        .filter(matchesFilter[filter.value])
        .filter(person => !tag || person.tags.some(personTag => personTag.toLowerCase() === tag))
        .filter(person => {
          const phones = person.phones.map(phone => `${phone.label} ${phone.number}`);
          const text = [person.name, person.address, ...phones, person.description, person.availableTimes.join(' '), person.tags.join(' '), person.lastNotes]
            .join('\n').toLowerCase();
          // "4235550100" finds "(423) 555-0100".
          const digits = person.phones.map(phone => phone.number.replace(/\D/g, '')).join(' ');
          return terms.every(term => text.includes(term) || (/^\+?[\d().-]{3,}$/.test(term) && digits.includes(term.replace(/\D/g, ''))));
        })
        .sort(comparePeople);
    });

    /* -- Person ---------------------------------------------------------- */

    function openPerson(person) {
      currentId.value = person.id;
      calendarOpen.value = false;
      readyShare.value = null;
      store.loadPictures(person.pictures);
      show('person');
    }

    // Pictures downloaded by a sync show up without reopening the person.
    watch(() => current.value && current.value.pictures, ids => {
      if (ids && view.value === 'person') store.loadPictures(ids);
    });

    function timesSummary(times) {
      return days
        .map(day => ({ day, periods: periods.filter(period => times.includes(`${day} ${period}`)) }))
        .filter(entry => entry.periods.length)
        .map(entry => `${t('day.' + entry.day)}: ${entry.periods.length === periods.length
          ? t('person.anyTime')
          : entry.periods.map(period => t('period.' + period)).join(', ')}`);
    }

    function openLightbox(ids, index) {
      lightbox.value = { ids, index };
    }

    function stepLightbox(step) {
      const box = lightbox.value;
      box.index = (box.index + step + box.ids.length) % box.ids.length;
    }

    const miniMapEl = ref(null);
    let miniMap = null;
    function syncMiniMap() {
      if (miniMap) {
        miniMap.remove();
        miniMap = null;
      }
      const coords = view.value === 'person' && current.value && parseCoords(current.value.coordinates);
      if (!coords || !miniMapEl.value) return;
      miniMap = L.map(miniMapEl.value, {
        zoomControl: false, dragging: false, touchZoom: false, scrollWheelZoom: false,
        doubleClickZoom: false, boxZoom: false, keyboard: false
      }).setView(coords, 16);
      addTiles(miniMap);
      L.marker(coords).addTo(miniMap);
    }
    watch(() => [view.value, current.value && current.value.coordinates], () => nextTick(syncMiniMap));

    /* -- Add / edit person ----------------------------------------------- */

    const form = reactive({});
    let formSnapshot = '';
    const processingPictures = ref(false);

    function formState() {
      return JSON.stringify({ ...form, newPictures: form.newPictures.length });
    }

    function fillForm(person) {
      Object.assign(form, {
        id: person ? person.id : '',
        name: person ? person.name : '',
        address: person ? person.address : '',
        phones: person ? person.phones.map(phone => ({ key: uuid(), ...phone })) : [],
        coordinates: person ? person.coordinates : '',
        description: person ? person.description : '',
        isStudy: person ? person.isStudy : false,
        availableTimes: person ? person.availableTimes.slice() : [],
        pictures: person ? person.pictures.slice() : [],
        newPictures: [],
        returnAt: person ? toLocalInput(person.returnAt) : '',
        tags: person ? person.tags.slice() : []
      });
      tagInput.value = '';
      formSnapshot = formState();
      closePicker();
    }

    function newPerson() {
      fillForm(null);
      show('editPerson');
    }

    function editPerson() {
      fillForm(current.value);
      store.loadPictures(form.pictures);
      show('editPerson');
    }

    function toggleRow(day) {
      toggleTimes(periods.map(period => `${day} ${period}`));
    }

    function toggleColumn(period) {
      toggleTimes(days.map(day => `${day} ${period}`));
    }

    function toggleTimes(times) {
      const allOn = times.every(time => form.availableTimes.includes(time));
      const others = form.availableTimes.filter(time => !times.includes(time));
      form.availableTimes = allOn ? others : others.concat(times);
    }

    async function addPictureFiles(event) {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      processingPictures.value = true;
      try {
        for (const file of files) {
          try {
            const picture = await shrinkImage(file, maxPictureBytes);
            form.newPictures.push({ key: Math.random().toString(36).slice(2), ...picture });
          } catch (err) {
            showError(err);
          }
        }
      } finally {
        processingPictures.value = false;
      }
    }

    async function savePersonForm() {
      if (!form.name.trim()) {
        showToast(t('form.nameRequired'), true);
        return;
      }
      const coords = parseCoords(form.coordinates);
      if (form.coordinates.trim() && !coords) {
        showToast(t('form.badCoordinates'), true);
        return;
      }
      const phones = form.phones
        .map(phone => ({ number: phone.number.replace(/\s+/g, ' ').trim(), label: phone.label.replace(/[:\s]+/g, ' ').trim() }))
        .filter(phone => phone.number);
      const badPhone = phones.find(phone => !isPhoneNumber(phone.number));
      if (badPhone) {
        showToast(t('phones.invalid', { number: badPhone.number }), true);
        return;
      }
      addTag();
      const isNew = !form.id;
      try {
        const person = await store.savePerson({
          id: form.id,
          name: form.name,
          address: form.address,
          phones,
          coordinates: coords ? formatCoords(coords[0], coords[1]) : '',
          description: form.description,
          isStudy: form.isStudy,
          availableTimes: form.availableTimes,
          pictures: form.pictures,
          returnAt: fromLocalInput(form.returnAt),
          tags: form.tags
        }, form.newPictures);
        closePicker();
        currentId.value = person.id;
        store.loadPictures(person.pictures);
        show('person');
        showToast(isNew ? t('form.added', { name: person.name }) : t('form.saved'));
      } catch (err) {
        showError(err);
      }
    }

    async function removePerson() {
      if (!confirm(t('form.deleteConfirm', { name: form.name }))) return;
      try {
        await store.deletePerson(form.id);
        storage.remove(draftKey(form.id));
        closePicker();
        currentId.value = '';
        show('list');
        showToast(t('form.deleted'));
      } catch (err) {
        showError(err);
      }
    }

    /* Phone numbers */

    function addPhone() {
      if (form.phones.length >= MAX_PHONES) return;
      const key = uuid();
      form.phones.push({ key, number: '', label: '' });
      nextTick(() => document.getElementById(`phone-${key}`).focus());
    }

    /* Tags */

    const tagInput = ref('');
    const tagSuggestions = computed(() => {
      const typed = tagInput.value.toLowerCase();
      const used = new Set((form.tags || []).map(tag => tag.toLowerCase()));
      return allTags.value
        .filter(tag => !used.has(tag.toLowerCase()) && tag.toLowerCase().startsWith(typed))
        .slice(0, 12);
    });

    // Spaces become hyphens and other punctuation is dropped as you type. A
    // comma adds the tag, since tags can't have one.
    function cleanTagInput(event) {
      const raw = event.target.value;
      if (/[,;]/.test(raw)) {
        addTag(raw.split(/[,;]/)[0]);
        return;
      }
      // A hyphen or space being typed stays until the next letter.
      const cleaned = cleanTag(raw);
      tagInput.value = cleaned && /[\s-]$/.test(raw) ? `${cleaned}-` : cleaned;
      event.target.value = tagInput.value;
    }

    function addTag(value = tagInput.value) {
      const tag = cleanTag(value);
      tagInput.value = '';
      if (!tag || !form.tags || form.tags.some(existing => existing.toLowerCase() === tag.toLowerCase())) return;
      form.tags.push(tag);
    }

    function tagBackspace(event) {
      if (!tagInput.value && form.tags.length) {
        event.preventDefault();
        tagInput.value = form.tags.pop();
      }
    }

    /* Sharing and calendar reminders */

    const sharing = ref(false);
    // When making the PDF takes long enough that the browser won't open the
    // share sheet anymore, it waits here for another tap.
    const readyShare = ref(null);
    const calendarOpen = ref(false);

    async function sharePerson() {
      const person = current.value;
      if (!person || sharing.value) return;
      sharing.value = true;
      readyShare.value = null;
      busy.value = t('share.making');
      let file;
      try {
        const blob = await personPdf({
          person,
          visits: visits.value,
          pictures: await store.pictureData(person.pictures),
          times: timesSummary(person.availableTimes)
        });
        file = new File([blob], pdfFileName(person.name), { type: 'application/pdf' });
        await deliverShare(file, person.name);
      } catch (err) {
        if (err.name === 'NotAllowedError' && file) {
          readyShare.value = { file, title: person.name };
        } else {
          showToast(t('share.failed', { error: err.message }), true);
        }
      } finally {
        busy.value = '';
        sharing.value = false;
      }
    }

    async function deliverShare(file, title) {
      if (await shareOrDownload(file, title) === 'downloaded') showToast(t('share.saved'));
    }

    async function shareReady() {
      const ready = readyShare.value;
      readyShare.value = null;
      try {
        await deliverShare(ready.file, ready.title);
      } catch (err) {
        showToast(t('share.failed', { error: err.message }), true);
      }
    }

    // iPhones offer to add an .ics file to Calendar when it's opened, so it's
    // opened there and downloaded everywhere else.
    function downloadCalendarFile(person) {
      const file = calendarFile(person);
      const url = URL.createObjectURL(file);
      if (isIos) {
        location.href = url;
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.download = file.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      calendarOpen.value = false;
    }

    /* -- Map picker ------------------------------------------------------ */

    const pickerOpen = ref(false);
    const pickerEl = ref(null);
    const locating = ref(false);
    let pickerMap = null;
    let pickerMarker = null;
    const placeQuery = ref('');
    const findingPlaces = ref(false);
    const places = ref([]);
    const placeIndex = ref(0);
    let previewMarker = null;

    // Without coordinates, the map starts near the most recently added
    // person who has some.
    function defaultCenter() {
      const recent = people.value
        .filter(person => parseCoords(person.coordinates))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return recent ? parseCoords(recent.coordinates) : null;
    }

    function openPicker() {
      if (pickerOpen.value) return;
      pickerOpen.value = true;
      placeQuery.value = form.address.replace(/\s+/g, ' ').trim();
      nextTick(() => {
        if (!pickerEl.value) return;
        const coords = parseCoords(form.coordinates);
        const center = coords || defaultCenter();
        pickerMap = L.map(pickerEl.value).setView(center || [20, 0], coords ? 17 : center ? 14 : 2);
        addTiles(pickerMap);
        if (coords) placeMarker(coords);
        pickerMap.on('click', event => setCoordsFromMap(event.latlng));
      });
    }

    function closePicker() {
      if (pickerMap) pickerMap.remove();
      pickerMap = pickerMarker = previewMarker = null;
      pickerOpen.value = false;
      places.value = [];
    }

    function togglePicker() {
      pickerOpen.value ? closePicker() : openPicker();
    }

    function placeMarker(latlng) {
      if (!pickerMap) return;
      if (pickerMarker) {
        pickerMarker.setLatLng(latlng);
      } else {
        pickerMarker = L.marker(latlng, { draggable: true }).addTo(pickerMap);
        pickerMarker.on('dragend', () => setCoordsFromMap(pickerMarker.getLatLng()));
      }
    }

    function setCoordsFromMap(latlng) {
      form.coordinates = formatCoords(latlng.lat, latlng.lng);
    }

    // Searches by address or Google Maps link. Matches are shown as an
    // orange dot until one is confirmed.
    async function findPlaces() {
      const query = placeQuery.value.trim();
      if (!query) {
        showToast(t('map.typeSomething'), true);
        return;
      }
      // Prefer matches near the area the map is showing.
      const bounds = pickerMap && pickerMap.getZoom() >= 10 ? pickerMap.getBounds() : null;
      findingPlaces.value = true;
      try {
        places.value = await callApi(store.state.active, 'findPlaces', {
          query,
          bounds: bounds && [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()]
        });
        previewPlace(0);
      } catch (err) {
        clearPlaces();
        if (err.code === 'network') {
          showToast(t('map.offline'), true);
        } else {
          showError(err);
        }
      } finally {
        findingPlaces.value = false;
      }
    }

    function previewPlace(index) {
      placeIndex.value = index;
      const coords = parseCoords(places.value[index].coordinates);
      if (!pickerMap || !coords) return;
      if (previewMarker) {
        previewMarker.setLatLng(coords);
      } else {
        previewMarker = L.circleMarker(coords, {
          radius: 11, color: '#fff', weight: 3, fillColor: '#f97316', fillOpacity: 1
        }).addTo(pickerMap);
      }
      pickerMap.setView(coords, 17);
    }

    function confirmPlace() {
      const place = places.value[placeIndex.value];
      form.coordinates = place.coordinates;
      if (!form.address.trim() && place.address) form.address = place.address;
      clearPlaces();
    }

    function clearPlaces() {
      places.value = [];
      if (previewMarker) previewMarker.remove();
      previewMarker = null;
    }

    watch(() => form.coordinates, value => {
      const coords = parseCoords(value);
      if (coords) placeMarker(coords);
    });

    function useMyLocation() {
      if (!navigator.geolocation) {
        showToast(t('location.unavailable'), true);
        openPicker();
        return;
      }
      locating.value = true;
      navigator.geolocation.getCurrentPosition(position => {
        locating.value = false;
        const { latitude, longitude } = position.coords;
        form.coordinates = formatCoords(latitude, longitude);
        if (pickerMap) {
          pickerMap.setView([latitude, longitude], 17);
        } else {
          openPicker();
        }
      }, err => {
        locating.value = false;
        showToast(t('location.failed', { error: err.message || t('location.denied') }), true);
        openPicker();
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    }

    /* -- Add / edit visit ------------------------------------------------ */

    const visitForm = reactive({});
    const hasVisitDraft = ref(false);
    const draftKey = personId => `rv-notes/visitDraft/${store.state.active ? store.state.active.id : ''}/${personId}`;

    function startVisit() {
      const person = current.value;
      const draft = storage.get(draftKey(person.id));
      const futureReturn = person.returnAt && new Date(person.returnAt) > new Date() ? person.returnAt : '';
      Object.assign(visitForm, {
        id: '',
        personId: person.id,
        createdAt: toLocalInput(new Date().toISOString()),
        notes: '',
        returnAt: toLocalInput(futureReturn),
        updateReturnAt: true,
        countStudy: person.isStudy
      }, draft || {});
      hasVisitDraft.value = !!draft;
      show('visit');
    }

    function editVisit(visit) {
      Object.assign(visitForm, {
        id: visit.id,
        personId: visit.personId,
        createdAt: toLocalInput(visit.createdAt),
        notes: visit.notes,
        returnAt: '',
        updateReturnAt: false,
        countStudy: false
      });
      hasVisitDraft.value = false;
      show('visit');
    }

    const visitMonth = computed(() => monthKey(visitForm.createdAt ? new Date(visitForm.createdAt) : new Date()));
    const visitStudyCounted = computed(() => isStudyCounted(visitForm.personId, visitMonth.value));

    watch(visitForm, () => {
      if (view.value !== 'visit' || visitForm.id) return;
      // Nothing is kept until there are notes, so opening the form and
      // backing out doesn't leave a stale start time behind.
      if (!visitForm.notes.trim()) {
        storage.remove(draftKey(visitForm.personId));
        hasVisitDraft.value = false;
        return;
      }
      storage.set(draftKey(visitForm.personId), {
        createdAt: visitForm.createdAt,
        notes: visitForm.notes,
        returnAt: visitForm.returnAt
      });
      hasVisitDraft.value = true;
    }, { deep: true });

    function discardVisitDraft() {
      if (!confirm(t('visit.discardConfirm'))) return;
      storage.remove(draftKey(visitForm.personId));
      hasVisitDraft.value = false;
      show('person');
    }

    function setReturnInWeeks(weeks) {
      const start = new Date(visitForm.createdAt || Date.now());
      start.setDate(start.getDate() + weeks * 7);
      visitForm.returnAt = toLocalInput(start.toISOString());
    }

    async function saveVisitForm() {
      const isNew = !visitForm.id;
      try {
        await store.saveVisit({
          id: visitForm.id,
          personId: visitForm.personId,
          createdAt: fromLocalInput(visitForm.createdAt),
          notes: visitForm.notes
        }, visitForm.updateReturnAt ? { returnAt: fromLocalInput(visitForm.returnAt) } : {});
        if (isNew) storage.remove(draftKey(visitForm.personId));
        if (isNew && visitForm.countStudy && !visitStudyCounted.value) {
          await addStudyFor(current.value, visitMonth.value);
        }
        show('person');
        showToast(isNew ? t('visit.saved') : t('form.saved'));
      } catch (err) {
        showError(err);
      }
    }

    async function removeVisit() {
      if (!confirm(t('visit.deleteConfirm'))) return;
      try {
        await store.deleteVisit(visitForm.id);
        show('person');
        showToast(t('visit.deleted'));
      } catch (err) {
        showError(err);
      }
    }

    /* -- Monthly report -------------------------------------------------- */

    const reportMonth = ref(monthKey());
    const reportData = computed(() => ({
      time: store.state.time, studies: store.state.studies, reports: store.state.reports, visits: store.state.visits
    }));
    const summary = computed(() => summarize(reportData.value, reportMonth.value));
    const reportName = computed(() => store.state.active && store.state.active.reportName || '');
    const currentReportText = computed(() => reportText(summary.value, { name: reportName.value, t }));
    const changedSinceSent = computed(() => summary.value.sent && summary.value.report.text !== currentReportText.value);
    const reportHistory = computed(() => i18n.locale && reportMonths(reportData.value).map(month => {
      const s = summarize(reportData.value, month);
      return { month, label: monthLabel(month), hours: s.service.liveHours, studies: s.studies.length, sent: s.sent };
    }));
    const reportComments = ref('');
    watch(() => [reportMonth.value, summary.value.comments], () => reportComments.value = summary.value.comments, { immediate: true });

    /* Calendar */

    // The first day of the week follows the device's region; the names follow
    // the app's language.
    const firstWeekday = weekStart(navigator.language);
    const weekdays = computed(() => i18n.locale && weekdayLabels(firstWeekday));
    const today = computed(() => dayKey(now.value));
    const calendar = computed(() => calendarCells(store.state.time, reportMonth.value, firstWeekday));
    // The day whose time is listed under the calendar. It starts on today in
    // the current month and the first day with time in other months.
    const selectedDay = ref('');
    watch(reportMonth, month => {
      if (selectedDay.value.startsWith(month)) return;
      const withTime = calendar.value.find(cell => cell && (cell.minutes || cell.creditMinutes));
      selectedDay.value = month === monthKey() ? dayKey() : withTime ? withTime.day : '';
    }, { immediate: true });
    const selectedDayEntries = computed(() => summary.value.entries.filter(entry => entry.date === selectedDay.value));

    function dayLabel(day) {
      return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    }

    function openReport(month = monthKey()) {
      reportMonth.value = month;
      show('report');
    }

    function stepMonth(count) {
      reportMonth.value = addMonths(reportMonth.value, count);
    }

    // Saves fields of the month's report, creating it if needed. Each month
    // has one report with a fixed ID, so two phones can't make two.
    function saveReport(fields) {
      const existing = summary.value.report || {
        id: reportId(reportMonth.value), month: reportMonth.value, shared: '', comments: '', sentAt: '', hours: '',
        creditHours: '', studies: '', carriedMinutes: '', carriedCreditMinutes: '', text: ''
      };
      return store.saveRecord('reports', { ...existing, ...fields }).catch(showError);
    }

    function setShared(value) {
      saveReport({ shared: value });
    }

    function saveComments() {
      if (reportComments.value.trim() !== summary.value.comments.trim()) saveReport({ comments: reportComments.value.trim() });
    }

    async function saveReportName(event) {
      const name = event.target.value.trim();
      if (name !== reportName.value) await store.updateConnection(store.state.active.id, { reportName: name });
    }

    function markSent() {
      const s = summary.value;
      return saveReport({
        sentAt: nowIso(),
        hours: s.service.liveHours,
        creditHours: s.credit.liveHours,
        studies: s.studies.length,
        carriedMinutes: s.service.liveCarriedOut,
        carriedCreditMinutes: s.credit.liveCarriedOut,
        text: currentReportText.value
      });
    }

    async function sendReport() {
      saveComments();
      await nextTick();
      const text = currentReportText.value;
      if (navigator.share) {
        try {
          await navigator.share({ text });
        } catch (err) {
          // Closing the share sheet isn't an error.
          if (err.name !== 'AbortError') showError(err);
          return;
        }
        await markSent();
        showToast(t('report.sentToast', { month: monthLabel(reportMonth.value) }));
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        showToast(t('report.copyFailed'), true);
        return;
      }
      if (confirm(t('report.copiedConfirm'))) await markSent();
    }

    /* Bible studies */

    function studyKey(study) {
      return study.personId || `name:${study.name.trim().toLowerCase()}`;
    }

    function isStudyCounted(personId, month) {
      return uniqueStudies(store.state.studies, month).some(study => study.personId === personId);
    }

    function addStudyFor(person, month) {
      return store.saveRecord('studies', { id: uuid(), month, personId: person.id, name: person.name });
    }

    const studyName = ref('');
    const studyPersonId = ref('');
    // People who aren't counted yet this month. Those marked Studying come
    // first as one-tap suggestions.
    const studyCandidates = computed(() => {
      const counted = new Set(summary.value.studies.map(study => study.personId).filter(Boolean));
      return people.value.filter(person => !counted.has(person.id)).sort((a, b) => a.name.localeCompare(b.name));
    });
    const studySuggestions = computed(() => studyCandidates.value.filter(person => person.isStudy));

    function studyDisplayName(study) {
      const person = study.personId && people.value.find(p => p.id === study.personId);
      return person ? person.name : study.name;
    }

    async function addStudyPerson(person) {
      await addStudyFor(person, reportMonth.value).catch(showError);
      studyPersonId.value = '';
    }

    async function addStudyName() {
      const name = studyName.value.trim();
      if (!name) return;
      if (summary.value.studies.some(study => studyKey(study) === `name:${name.toLowerCase()}`)) {
        showToast(t('study.alreadyCounted', { name }), true);
        return;
      }
      await store.saveRecord('studies', { id: uuid(), month: reportMonth.value, personId: '', name }).catch(showError);
      studyName.value = '';
    }

    // Removes every copy (two phones may have added the same study).
    async function removeStudy(study, month = reportMonth.value) {
      const key = studyKey(study);
      for (const s of store.state.studies.filter(s => s.month === month && studyKey(s) === key)) {
        await store.deleteRecord('studies', s.id).catch(showError);
      }
    }

    // The toggle on a person's page counts them for the current month.
    const personStudyMonth = computed(() => monthKey(now.value));
    const personStudyCounted = computed(() => current.value && isStudyCounted(current.value.id, personStudyMonth.value));
    function togglePersonStudy() {
      const person = current.value;
      if (personStudyCounted.value) {
        removeStudy({ personId: person.id, name: person.name }, personStudyMonth.value);
      } else {
        addStudyFor(person, personStudyMonth.value).catch(showError);
      }
    }

    /* Time entries and the timer */

    const timerKey = () => `rv-notes/timer/${store.state.active ? store.state.active.id : ''}`;
    const timer = ref(null);
    const clock = ref(Date.now());
    let clockInterval = null;
    watch(() => store.state.active && store.state.active.id, () => timer.value = storage.get(timerKey()), { immediate: true });
    watch(timer, value => {
      clearInterval(clockInterval);
      if (value) clockInterval = setInterval(() => clock.value = Date.now(), 1000);
    }, { immediate: true });

    const timerElapsed = computed(() => {
      if (!timer.value) return '';
      const seconds = Math.max(0, Math.floor((clock.value - new Date(timer.value.startedAt)) / 1000));
      const pad = n => String(n).padStart(2, '0');
      return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
    });

    function startTimer() {
      timer.value = { startedAt: nowIso() };
      clock.value = Date.now();
      storage.set(timerKey(), timer.value);
    }

    const timeForm = reactive({});
    let timeSnapshot = '';

    function fillTimeForm(fields) {
      Object.assign(timeForm, { id: '', date: dayKey(), hours: 0, minutes: 0, kind: 'service', note: '', fromTimer: false }, fields);
      timeSnapshot = JSON.stringify(timeForm);
      show('timeEntry');
    }

    function stopTimer() {
      const start = new Date(timer.value.startedAt);
      const minutes = Math.max(1, Math.round((Date.now() - start) / 60000));
      fillTimeForm({ date: dayKey(start), hours: Math.floor(minutes / 60), minutes: minutes % 60, fromTimer: true });
    }

    function newTimeEntry(day = selectedDay.value) {
      const month = reportMonth.value;
      fillTimeForm({ date: day || (month === monthKey() ? dayKey() : `${month}-01`) });
    }

    function editTimeEntry(entry) {
      fillTimeForm({
        id: entry.id, date: entry.date, hours: Math.floor(entry.minutes / 60), minutes: entry.minutes % 60,
        kind: entry.kind, note: entry.note
      });
    }

    function setDuration(minutes) {
      timeForm.hours = Math.floor(minutes / 60);
      timeForm.minutes = minutes % 60;
    }

    async function saveTimeForm() {
      const minutes = (Number(timeForm.hours) || 0) * 60 + (Number(timeForm.minutes) || 0);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
        showToast(t('time.invalid'), true);
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(timeForm.date)) {
        showToast(t('time.chooseDate'), true);
        return;
      }
      try {
        await store.saveRecord('time', {
          id: timeForm.id || uuid(), date: timeForm.date, minutes, kind: timeForm.kind, note: timeForm.note.trim()
        });
        if (timeForm.fromTimer) {
          timer.value = null;
          storage.remove(timerKey());
        }
        reportMonth.value = timeForm.date.slice(0, 7);
        selectedDay.value = timeForm.date;
        show('report');
        showToast(t('time.saved', { time: formatMinutes(minutes) }));
      } catch (err) {
        showError(err);
      }
    }

    async function removeTimeEntry() {
      if (!confirm(t('time.deleteConfirm'))) return;
      await store.deleteRecord('time', timeForm.id).catch(showError);
      show('report');
      showToast(t('form.deleted'));
    }

    /* -- QR code scanner ----------------------------------------------------- */

    const scanner = reactive({ open: false, message: '' });
    const scannerVideo = ref(null);
    let stopScanning = null;

    async function openScanner() {
      scanner.open = true;
      scanner.message = t('scan.starting');
      await nextTick();
      try {
        const stop = await startScanner(scannerVideo.value, text => {
          const link = parseConnectLink(text);
          if (!link) {
            scanner.message = t('scan.notOurs');
            return false;
          }
          closeScanner();
          connectForm.link = text;
          connectForm.name = '';
          show('addConnection');
          return true;
        });
        if (!scanner.open) {
          stop();
          return;
        }
        stopScanning = stop;
        scanner.message = t('scan.point');
      } catch (err) {
        closeScanner();
        showError(err);
      }
    }

    function closeScanner() {
      scanner.open = false;
      if (stopScanning) stopScanning();
      stopScanning = null;
    }

    /* -- Navigation ------------------------------------------------------ */

    const title = computed(() => {
      if (view.value === 'list') return store.state.active ? store.state.active.name : 'RV Notes';
      if (view.value === 'person') return current.value ? current.value.name : '';
      if (view.value === 'editPerson') return form.id ? t('title.editRv', { name: current.value ? current.value.name : '' }) : t('title.newRv');
      if (view.value === 'visit') return t(visitForm.id ? 'title.editVisit' : 'title.newVisit');
      if (view.value === 'connections') return t('title.settings');
      if (view.value === 'addConnection') return t(connectExisting.value ? 'title.reconnect' : 'title.addSpreadsheet');
      if (view.value === 'report') return t('title.report');
      if (view.value === 'timeEntry') return t(timeForm.id ? 'title.editTime' : 'title.addTime');
      return 'RV Notes';
    });

    const subtitle = computed(() => {
      if (busy.value) return busy.value;
      if (view.value === 'visit' && current.value) return current.value.name;
      if (view.value === 'list') return syncSummary.value;
      if (view.value === 'report') return store.state.active ? store.state.active.name : '';
      return '';
    });

    const subtitleClass = computed(() => view.value === 'list' && !busy.value && ['auth', 'error'].includes(store.state.status)
      ? 'text-red-600 dark:text-red-400'
      : 'text-slate-500 dark:text-slate-400');

    const canGoBack = computed(() => !['list', 'welcome', 'loading'].includes(view.value));

    function goBack() {
      if (view.value === 'editPerson') {
        if (formState() !== formSnapshot && !confirm(t('form.discard'))) return;
        closePicker();
        show(form.id && current.value && current.value.id === form.id ? 'person' : 'list');
      } else if (view.value === 'visit') {
        show('person');
      } else if (view.value === 'addConnection') {
        show(store.state.connections.length ? 'connections' : 'welcome');
      } else if (view.value === 'timeEntry') {
        if (timeForm.fromTimer) {
          if (!confirm(t('time.discardTimer'))) return;
          timer.value = null;
          storage.remove(timerKey());
        } else if (JSON.stringify(timeForm) !== timeSnapshot && !confirm(t('form.discard'))) {
          return;
        }
        show('report');
      } else {
        show('list');
      }
    }

    /* -- Start ----------------------------------------------------------- */

    // A link from RV Notes → Connect app opens the app with #connect=… The
    // link holds the key, so it's removed from the address bar right away.
    function takeConnectLink() {
      if (!/^#connect=/.test(location.hash)) return false;
      connectForm.link = location.href;
      connectForm.name = '';
      history.replaceState(null, '', location.pathname + location.search);
      return true;
    }

    window.addEventListener('hashchange', () => {
      if (takeConnectLink()) show('addConnection');
    });

    (async () => {
      const hasLink = takeConnectLink();
      try {
        await store.init();
      } catch (err) {
        showError(err);
      }
      if (hasLink) {
        show('addConnection');
      } else {
        show(store.state.active ? 'list' : 'welcome');
      }
      autoSync();
      registerServiceWorker();
    })();

    return {
      store: store.state, days, periods, maxPictureBytes, view, busy, toast, search, filter, filters, now,
      people, filteredPeople, current, visits, pictureCache, lightbox, title, subtitle, subtitleClass, canGoBack,
      syncIcon, syncNow, updateReady, applyUpdate, showInstallTip, dismissInstallTip, isIos, isStandalone,
      connectForm, connectLink, connectExisting, pendingCounts, startAddConnection, openConnections,
      saveConnectionForm, switchConnection, renameConnection, removeConnection, redownload, copyText, changesWaiting,
      form, processingPictures, pickerOpen, pickerEl, miniMapEl, locating, visitForm, hasVisitDraft,
      openPerson, newPerson, editPerson, goBack, toggleTimes, toggleRow, toggleColumn, addPictureFiles,
      savePersonForm, removePerson, togglePicker, useMyLocation,
      placeQuery, findingPlaces, places, placeIndex, findPlaces, previewPlace, confirmPlace, clearPlaces,
      startVisit, editVisit, saveVisitForm, removeVisit, discardVisitDraft, setReturnInWeeks, openLightbox, stepLightbox,
      markdown, formatDateTime, shortDate, relative, returnBadgeClass, firstLine, timesSummary,
      mapQuery, mapsUrl, directionsUrl, telUrl, smsUrl, whatsAppUrl, addPhone, maxPhones: MAX_PHONES,
      visitMonth, visitStudyCounted, monthLabel, formatMinutes, monthKey, addMonths,
      reportMonth, summary, reportName, currentReportText, changedSinceSent, reportHistory, reportComments,
      openReport, stepMonth, setShared, saveComments, saveReportName, sendReport,
      studyName, studyPersonId, studyCandidates, studySuggestions, studyDisplayName, addStudyPerson, addStudyName, removeStudy,
      personStudyMonth, personStudyCounted, togglePersonStudy,
      weekdays, today, calendar, selectedDay, selectedDayEntries, dayLabel, clockMinutes,
      timer, timerElapsed, startTimer, stopTimer, timeForm, newTimeEntry, editTimeEntry, setDuration, saveTimeForm, removeTimeEntry,
      scanner, scannerVideo, openScanner, closeScanner,
      t, language, languages, changeLanguage, allTags, tagFilter,
      tagInput, tagSuggestions, cleanTagInput, addTag, tagBackspace,
      sharing, readyShare, sharePerson, shareReady, calendarOpen, googleCalendarUrl, downloadCalendarFile
    };
  }
});
app.component('md-editor', MdEditor);
app.mount('#app');
