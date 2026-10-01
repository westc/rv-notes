import { createApp, ref, reactive, computed, watch, nextTick } from '../vendor/vue.esm-browser.prod.js';
import * as L from '../vendor/leaflet/leaflet-src.esm.js';
import { callApi } from './api.js';
import { createStore } from './store.js';
import {
  addMonths, dayKey, formatMinutes, monthKey, monthLabel, reportId, reportMonths, reportText, summarize, uniqueStudies
} from './report.js';
import { startScanner } from './scanner.js';
import {
  DAYS, PERIODS, MAX_PICTURE_BYTES, markdown, storage, decodeBase64Url, toLocalInput, fromLocalInput,
  formatDateTime, shortDate, relative, endOfToday, returnBadgeClass, firstLine, parseCoords, formatCoords,
  mapQuery, mapsUrl, directionsUrl, shrinkImage, uuid, nowIso
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
  return `${count} ${count === 1 ? 'change' : 'changes'} waiting`;
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
    return { preview: ref(false), markdown };
  },
  template: `
    <div class="overflow-hidden rounded-lg ring-1 ring-slate-300 focus-within:ring-2 focus-within:ring-indigo-500 dark:ring-slate-600">
      <div class="flex items-center border-b border-slate-200 bg-slate-50 text-sm dark:border-slate-700 dark:bg-slate-800">
        <button type="button" class="px-3 py-2" :class="preview ? 'text-slate-500' : 'font-semibold text-indigo-600 dark:text-indigo-400'" @click="preview = false">Write</button>
        <button type="button" class="px-3 py-2" :class="preview ? 'font-semibold text-indigo-600 dark:text-indigo-400' : 'text-slate-500'" @click="preview = true">Preview</button>
        <a class="ml-auto px-3 py-2 text-xs text-slate-500" href="https://www.markdownguide.org/basic-syntax/" target="_blank" rel="noopener">Markdown help</a>
      </div>
      <textarea v-if="!preview" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)"
        :rows="rows" :placeholder="placeholder"
        class="block w-full resize-y border-0 bg-white p-3 text-base focus:outline-none focus:ring-0 dark:bg-slate-900"></textarea>
      <div v-else class="prose prose-sm min-h-[8rem] max-w-none bg-white p-3 dark:prose-invert dark:bg-slate-900">
        <div v-if="modelValue" v-html="markdown(modelValue)"></div>
        <p v-else class="italic text-slate-400">Nothing to preview.</p>
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

    // People with how many visits they have and when the latest one was.
    const people = computed(() => {
      const stats = {};
      store.state.visits.forEach(visit => {
        const stat = stats[visit.personId] || (stats[visit.personId] = { count: 0, last: '' });
        stat.count++;
        if (visit.createdAt > stat.last) stat.last = visit.createdAt;
      });
      return store.state.people.map(person => ({
        ...person,
        visitCount: stats[person.id] ? stats[person.id].count : 0,
        lastVisitAt: stats[person.id] ? stats[person.id].last : ''
      }));
    });

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
        ? `The spreadsheet didn’t accept a change: ${first.error}`
        : `The spreadsheet didn’t accept ${rejected.length} changes. The first problem: ${first.error}`, true);
    });

    /* -- Syncing -------------------------------------------------------- */

    function autoSync() {
      if (store.state.active) store.sync().catch(() => {});
    }

    async function syncNow() {
      if (store.state.status === 'syncing') return;
      try {
        await store.sync();
        showToast('Synced.');
      } catch (err) {
        showError(err);
      }
    }

    const syncIcon = computed(() => {
      const { status, pending } = store.state;
      if (status === 'syncing') return { icon: 'bi-arrow-repeat inline-block animate-spin', label: 'Syncing' };
      if (status === 'auth') return { icon: 'bi-key', color: 'text-red-600 dark:text-red-400', label: 'Can’t sync' };
      if (status === 'error') return { icon: 'bi-exclamation-triangle', color: 'text-amber-600 dark:text-amber-400', label: 'Sync problem. Try again' };
      if (status === 'offline') return { icon: 'bi-cloud-slash', label: 'Offline. Try again' };
      if (pending) return { icon: 'bi-cloud-arrow-up', label: 'Sync now' };
      return { icon: 'bi-cloud-check', label: 'Sync now' };
    });

    const syncSummary = computed(() => {
      const { status, pending, active } = store.state;
      if (status === 'syncing') return 'Syncing…';
      if (status === 'offline') return pending ? `Offline · ${changesWaiting(pending)}` : 'Offline';
      if (status === 'auth') return 'Can’t sync: the key changed';
      if (status === 'error') return 'Couldn’t sync. Tap the warning to try again.';
      if (pending) return changesWaiting(pending);
      return active && active.lastSyncAt ? `Synced ${relative(active.lastSyncAt, now.value)}` : '';
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
      if (view.value === 'editPerson' && formState() !== formSnapshot && !confirm('Discard your changes and reload?')) return;
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
      const name = connectForm.name.trim() || link.name || 'My RVs';
      const existing = connectExisting.value;
      busy.value = 'Checking the link…';
      try {
        await callApi(link, 'info');
      } catch (err) {
        busy.value = '';
        if (err.code !== 'network') {
          showError(err);
          return;
        }
        if (!confirm(`${err.message}\n\nAdd this spreadsheet anyway? It will sync once it can reach the spreadsheet.`)) return;
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
      showToast(existing ? `Reconnected ${name}.` : `Connected ${name}.`);
      autoSync();
    }

    async function switchConnection(id) {
      await store.switchTo(id);
      resetView();
      show('list');
      autoSync();
    }

    async function renameConnection(connection) {
      const name = prompt('Name on this device', connection.name);
      if (name && name.trim()) await store.updateConnection(connection.id, { name: name.trim() });
    }

    async function removeConnection(connection) {
      const waiting = await store.pendingCount(connection.id);
      const warning = waiting
        ? `\n\n${changesWaiting(waiting)} to be sent to the spreadsheet. ${waiting === 1 ? 'It' : 'They'} will be lost.`
        : '';
      if (!confirm(`Remove ${connection.name} from this device? The spreadsheet isn’t changed.${warning}`)) return;
      await store.removeConnection(connection.id);
      delete pendingCounts[connection.id];
      if (!store.state.connections.length) show('welcome');
      showToast(`Removed ${connection.name}.`);
    }

    function redownload() {
      run('Downloading…', () => store.redownload())
        .then(() => showToast('Downloaded everything again.'))
        .catch(() => {});
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        showToast('Copied.');
      } catch (err) {
        showToast('Couldn’t copy. Select the link and copy it instead.', true);
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
      { key: 'all', label: 'All' },
      { key: 'due', label: 'Due' },
      { key: 'upcoming', label: 'Upcoming' },
      { key: 'study', label: 'Studies' }
    ].map(f => ({ ...f, count: people.value.filter(matchesFilter[f.key]).length })));

    // People with a return date come first (soonest first), then everyone
    // else by most recent activity.
    function comparePeople(a, b) {
      if (a.returnAt && b.returnAt) return a.returnAt.localeCompare(b.returnAt);
      if (a.returnAt || b.returnAt) return a.returnAt ? -1 : 1;
      return (b.lastVisitAt || b.createdAt).localeCompare(a.lastVisitAt || a.createdAt);
    }

    const filteredPeople = computed(() => {
      const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      return people.value
        .filter(matchesFilter[filter.value])
        .filter(person => {
          const text = [person.name, person.address, person.description, person.availableTimes.join(' ')].join('\n').toLowerCase();
          return terms.every(term => text.includes(term));
        })
        .sort(comparePeople);
    });

    /* -- Person ---------------------------------------------------------- */

    function openPerson(person) {
      currentId.value = person.id;
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
        .map(entry => `${entry.day}: ${entry.periods.length === periods.length ? 'Any time' : entry.periods.join(', ')}`);
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
        coordinates: person ? person.coordinates : '',
        description: person ? person.description : '',
        isStudy: person ? person.isStudy : false,
        availableTimes: person ? person.availableTimes.slice() : [],
        pictures: person ? person.pictures.slice() : [],
        newPictures: [],
        returnAt: person ? toLocalInput(person.returnAt) : ''
      });
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
        showToast('Name is required.', true);
        return;
      }
      const coords = parseCoords(form.coordinates);
      if (form.coordinates.trim() && !coords) {
        showToast('Coordinates must be "latitude, longitude", for example "35.046900, -85.309700".', true);
        return;
      }
      const isNew = !form.id;
      try {
        const person = await store.savePerson({
          id: form.id,
          name: form.name,
          address: form.address,
          coordinates: coords ? formatCoords(coords[0], coords[1]) : '',
          description: form.description,
          isStudy: form.isStudy,
          availableTimes: form.availableTimes,
          pictures: form.pictures,
          returnAt: fromLocalInput(form.returnAt)
        }, form.newPictures);
        closePicker();
        currentId.value = person.id;
        store.loadPictures(person.pictures);
        show('person');
        showToast(isNew ? `Added ${person.name}.` : 'Saved.');
      } catch (err) {
        showError(err);
      }
    }

    async function removePerson() {
      if (!confirm(`Delete ${form.name} along with all of their visits and pictures? This can't be undone.`)) return;
      try {
        await store.deletePerson(form.id);
        storage.remove(draftKey(form.id));
        closePicker();
        currentId.value = '';
        show('list');
        showToast('Deleted.');
      } catch (err) {
        showError(err);
      }
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
        showToast('Type an address or paste a Google Maps link.', true);
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
          showToast('Searching needs an internet connection. You can still tap the map or use your location.', true);
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
        showToast('Location isn’t available in this browser. Tap the map to drop a pin instead.', true);
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
        showToast(`Couldn’t get your location (${err.message || 'permission denied'}). Tap the map to drop a pin instead.`, true);
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
      if (!confirm('Discard this draft?')) return;
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
        showToast(isNew ? 'Visit saved.' : 'Saved.');
      } catch (err) {
        showError(err);
      }
    }

    async function removeVisit() {
      if (!confirm('Delete this visit? This can’t be undone.')) return;
      try {
        await store.deleteVisit(visitForm.id);
        show('person');
        showToast('Visit deleted.');
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
    const currentReportText = computed(() => reportText(summary.value, { name: reportName.value }));
    const changedSinceSent = computed(() => summary.value.sent && summary.value.report.text !== currentReportText.value);
    const reportHistory = computed(() => reportMonths(reportData.value).map(month => {
      const s = summarize(reportData.value, month);
      return { month, label: monthLabel(month), hours: s.service.liveHours, studies: s.studies.length, sent: s.sent };
    }));
    const reportComments = ref('');
    watch(() => [reportMonth.value, summary.value.comments], () => reportComments.value = summary.value.comments, { immediate: true });

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
        showToast(`${monthLabel(reportMonth.value)} report sent.`);
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        showToast('Couldn’t copy the report. Select the text and copy it instead.', true);
        return;
      }
      if (confirm('The report was copied. Paste it into a message or email.\n\nMark it as sent?')) await markSent();
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
        showToast(`${name} is already counted.`, true);
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

    function newTimeEntry() {
      const month = reportMonth.value;
      fillTimeForm({ date: month === monthKey() ? dayKey() : `${month}-01` });
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
        showToast('Enter between 1 minute and 24 hours, in whole minutes.', true);
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(timeForm.date)) {
        showToast('Choose a date.', true);
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
        show('report');
        showToast(`Saved ${formatMinutes(minutes)}.`);
      } catch (err) {
        showError(err);
      }
    }

    async function removeTimeEntry() {
      if (!confirm('Delete this time entry?')) return;
      await store.deleteRecord('time', timeForm.id).catch(showError);
      show('report');
      showToast('Deleted.');
    }

    /* -- QR code scanner ----------------------------------------------------- */

    const scanner = reactive({ open: false, message: '' });
    const scannerVideo = ref(null);
    let stopScanning = null;

    async function openScanner() {
      scanner.open = true;
      scanner.message = 'Starting the camera…';
      await nextTick();
      try {
        const stop = await startScanner(scannerVideo.value, text => {
          const link = parseConnectLink(text);
          if (!link) {
            scanner.message = 'That isn’t an RV Notes code. In the spreadsheet, choose RV Notes → Connect app.';
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
        scanner.message = 'Point the camera at the QR code from RV Notes → Connect app.';
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
      if (view.value === 'editPerson') return form.id ? `Edit ${current.value ? current.value.name : ''}` : 'New RV';
      if (view.value === 'visit') return visitForm.id ? 'Edit Visit' : 'New Visit';
      if (view.value === 'connections') return 'Spreadsheets';
      if (view.value === 'addConnection') return connectExisting.value ? 'Reconnect a Spreadsheet' : 'Add a Spreadsheet';
      if (view.value === 'report') return 'Monthly Report';
      if (view.value === 'timeEntry') return timeForm.id ? 'Edit Time' : 'Add Time';
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
        if (formState() !== formSnapshot && !confirm('Discard your changes?')) return;
        closePicker();
        show(form.id && current.value && current.value.id === form.id ? 'person' : 'list');
      } else if (view.value === 'visit') {
        show('person');
      } else if (view.value === 'addConnection') {
        show(store.state.connections.length ? 'connections' : 'welcome');
      } else if (view.value === 'timeEntry') {
        if (timeForm.fromTimer) {
          if (!confirm('Discard this time? The timer will be cleared.')) return;
          timer.value = null;
          storage.remove(timerKey());
        } else if (JSON.stringify(timeForm) !== timeSnapshot && !confirm('Discard your changes?')) {
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
      mapQuery, mapsUrl, directionsUrl,
      visitMonth, visitStudyCounted, monthLabel, formatMinutes, monthKey, addMonths,
      reportMonth, summary, reportName, currentReportText, changedSinceSent, reportHistory, reportComments,
      openReport, stepMonth, setShared, saveComments, saveReportName, sendReport,
      studyName, studyPersonId, studyCandidates, studySuggestions, studyDisplayName, addStudyPerson, addStudyName, removeStudy,
      personStudyMonth, personStudyCounted, togglePersonStudy,
      timer, timerElapsed, startTimer, stopTimer, timeForm, newTimeEntry, editTimeEntry, setDuration, saveTimeForm, removeTimeEntry,
      scanner, scannerVideo, openScanner, closeScanner
    };
  }
});
app.component('md-editor', MdEditor);
app.mount('#app');
