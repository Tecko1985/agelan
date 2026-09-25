// Gegenprobe am ECHTEN Code: berechneZeitplan wird samt Hilfsfunktionen aus
// turnier-service.js herausgeschnitten und in Node laufen gelassen. Keine
// Nachbildung - eine Kopie waere in dem Moment falsch, in dem jemand das
// Original aendert.
import fs from 'fs';

const src = fs.readFileSync('E:/agelan/turnier-service.js', 'utf8');

function holFunktion(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('nicht gefunden: ' + name);
  let d = 0;
  const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('Klammer nicht geschlossen: ' + name);
}
function holKonstante(name) {
  const i = src.indexOf('const ' + name + ' =');
  if (i < 0) throw new Error('nicht gefunden: ' + name);
  const ende = src.indexOf('\n};', i);
  if (ende > 0 && ende < i + 400) return src.slice(i, ende + 3);
  return src.slice(i, src.indexOf('\n', i) + 1);
}

const code = [
  holKonstante('ZP_VORGABE'),
  holKonstante('ZP_MAX_FENSTER'),
  holFunktion('zpMinuten'),
  holFunktion('zpZeitText'),
  holFunktion('zpEndeMinuten'),
  holFunktion('zpDatumPlus'),
  holFunktion('zpIstFreilos'),
  holFunktion('zpBloecke'),
  holFunktion('berechneZeitplan'),
  holFunktion('zpPruefeEinstellungen'),
  'return { berechneZeitplan, zpPruefeEinstellungen, zpIstFreilos };',
].join('\n\n');

const { berechneZeitplan, zpPruefeEinstellungen, zpIstFreilos } = new Function(code)();

let fehler = 0;
function pruefe(name, bedingung, zusatz) {
  if (bedingung) { console.log('OK    ' + name); return; }
  fehler++;
  console.log('FEHL  ' + name + (zusatz ? '  ->  ' + zusatz : ''));
}

const opt = {
  startDatum: '2026-10-01', startZeit: '14:00', dauerMin: 60,
  pauseMin: 0, gleichzeitig: 1, tagesEnde: '22:00',
};

// --- 1) Jeder gegen jeden, 4 Teams, ein Platz ------------------------------
// Alle 6 Spiele stehen in Runde 0. Sie muessen hintereinander liegen.
const rr = [];
const teams = ['t1', 't2', 't3', 't4'];
let n = 0;
for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
  rr.push({ id: 'g_A_' + a + '_' + b, phase: 'gruppe', gruppe: 'A', runde: 0, position: n++, teamA: teams[a], teamB: teams[b], status: 'offen' });
}
const p1 = berechneZeitplan(rr, opt);
pruefe('6 Spiele bekommen 6 Zeiten', Object.keys(p1).length === 6, Object.keys(p1).length);
const zeiten1 = rr.map((s) => p1[s.id]);
pruefe('alle Zeiten verschieden (1 Platz)', new Set(zeiten1).size === 6, zeiten1.join(' '));
pruefe('erstes Spiel um 14:00', p1[rr[0].id] === '2026-10-01T14:00', p1[rr[0].id]);
pruefe('Stundentakt ohne Pause', p1[rr[1].id] === '2026-10-01T15:00', p1[rr[1].id]);

// --- 2) Tagesgrenze: 14:00-22:00 sind 8 Fenster a 60 Min -------------------
const viele = [];
for (let i = 0; i < 10; i++) {
  viele.push({ id: 'x' + i, phase: 'gruppe', gruppe: 'A', runde: i, position: 0, teamA: 'a' + i, teamB: 'b' + i, status: 'offen' });
}
const p2 = berechneZeitplan(viele, opt);
pruefe('Spiel 8 faellt auf den naechsten Tag', p2.x8 === '2026-10-02T14:00', p2.x8);
pruefe('kein Spiel nach 21:00 begonnen', Object.values(p2).every((v) => v.slice(11) <= '21:00'), JSON.stringify(p2));

// --- 3) Zwei Plaetze, aber kein Team zweimal gleichzeitig ------------------
const opt2 = Object.assign({}, opt, { gleichzeitig: 2 });
const p3 = berechneZeitplan(rr, opt2);
const proZeit = {};
rr.forEach((s) => {
  const t = p3[s.id];
  proZeit[t] = proZeit[t] || [];
  proZeit[t].push(s);
});
let doppelt = '';
Object.keys(proZeit).forEach((t) => {
  const benutzt = {};
  proZeit[t].forEach((s) => {
    [s.teamA, s.teamB].forEach((x) => { if (benutzt[x]) doppelt = t + ' / ' + x; benutzt[x] = true; });
  });
});
pruefe('kein Team zweimal zur selben Zeit', !doppelt, doppelt);
pruefe('hoechstens 2 Spiele je Zeit', Object.values(proZeit).every((l) => l.length <= 2), JSON.stringify(Object.values(proZeit).map((l) => l.length)));
const spaetestes = (o) => Object.values(o).sort().pop();
pruefe('mit 2 Plaetzen frueher fertig als mit 1', spaetestes(p3) < spaetestes(p1),
  spaetestes(p3) + ' vs ' + spaetestes(p1));

// --- 4) K.-o.: Runde 2 faengt erst nach Runde 1 an -------------------------
const ko = [
  { id: 'ko_r0_p0', phase: 'ko', runde: 0, position: 0, teamA: 'a', teamB: 'b', status: 'offen' },
  { id: 'ko_r0_p1', phase: 'ko', runde: 0, position: 1, teamA: 'c', teamB: 'd', status: 'offen' },
  { id: 'ko_r1_p0', phase: 'ko', runde: 1, position: 0, teamA: 'a', teamB: 'c', status: 'offen' },
];
const p4 = berechneZeitplan(ko, Object.assign({}, opt, { gleichzeitig: 2 }));
pruefe('Halbfinals gleichzeitig', p4.ko_r0_p0 === p4.ko_r0_p1, p4.ko_r0_p0 + ' / ' + p4.ko_r0_p1);
pruefe('Finale danach', p4.ko_r1_p0 > p4.ko_r0_p0, JSON.stringify(p4));

// --- 5) Gruppenphase vor K.-o. --------------------------------------------
const gemischt = rr.concat(ko);
const p5 = berechneZeitplan(gemischt, opt);
const letztesGruppe = rr.map((s) => p5[s.id]).sort().pop();
const erstesKo = ko.map((s) => p5[s.id]).sort()[0];
pruefe('K.-o. beginnt nach der Gruppenphase', erstesKo > letztesGruppe, erstesKo + ' / ' + letztesGruppe);

// --- 6) Lange Spiele: 180 Min, Tag 14:00-22:00 ----------------------------
const optLang = Object.assign({}, opt, { dauerMin: 180, pauseMin: 15 });
const p6 = berechneZeitplan(viele.slice(0, 5), optLang);
// 14:00 und 17:15 passen; ein drittes Spiel um 20:30 waere erst um 23:30 aus
// und liegt damit hinter dem Tagesende 22:00.
pruefe('3h-Spiele: 2 je Tag, dann naechster Tag',
  p6.x0 === '2026-10-01T14:00' && p6.x1 === '2026-10-01T17:15' && p6.x2 === '2026-10-02T14:00',
  JSON.stringify(p6));
pruefe('kein Spiel endet nach dem Tagesende',
  Object.values(p6).every((v) => {
    const [h, m] = v.slice(11).split(':').map(Number);
    return h * 60 + m + 180 <= 22 * 60;
  }), JSON.stringify(p6));

// --- 7) Freilos wird erkannt ----------------------------------------------
pruefe('Freilos ohne Gegner erkannt', zpIstFreilos({ teamA: 'a', teamB: null }) === true);
pruefe('Freilos per gemeldetVon erkannt', zpIstFreilos({ teamA: 'a', teamB: 'b', gemeldetVon: 'freilos' }) === true);
pruefe('normales Spiel ist kein Freilos', zpIstFreilos({ teamA: 'a', teamB: 'b', gemeldetVon: null }) === false);

// --- 8) Einstellungen pruefen ---------------------------------------------
pruefe('gute Einstellungen gehen durch', zpPruefeEinstellungen(opt) === '');
pruefe('Tag zu kurz wird abgefangen',
  zpPruefeEinstellungen(Object.assign({}, opt, { dauerMin: 180, tagesEnde: '16:00' })) !== '');
pruefe('kaputte Uhrzeit wird abgefangen',
  zpPruefeEinstellungen(Object.assign({}, opt, { startZeit: '25:99' })) !== '');
pruefe('fehlendes Datum wird abgefangen',
  zpPruefeEinstellungen(Object.assign({}, opt, { startDatum: '' })) !== '');
pruefe('0 Plaetze wird abgefangen',
  zpPruefeEinstellungen(Object.assign({}, opt, { gleichzeitig: 0 })) !== '');

// --- 9) Abend ueber Mitternacht: 18:00-02:00 (Bugjagd 25.09.d T5-6) -------
const nacht = Object.assign({}, opt, { startZeit: '18:00', tagesEnde: '02:00', dauerMin: 60, pauseMin: 10 });
pruefe('18:00 bis 02:00 ist planbar', zpPruefeEinstellungen(nacht) === '', zpPruefeEinstellungen(nacht));
const kette = [];
for (let i = 0; i < 9; i++) kette.push({ id: 'k' + i, phase: 'gruppe', gruppe: 'A', runde: i, position: 0, teamA: 'a' + i, teamB: 'b' + i, status: 'offen' });
const p9 = berechneZeitplan(kette, nacht);
pruefe('6. Spiel 23:50 am ersten Tag', p9.k5 === '2026-10-01T23:50', p9.k5);
pruefe('7. Spiel 01:00 schon am Kalendertag danach', p9.k6 === '2026-10-02T01:00', p9.k6);
pruefe('8. Spiel am naechsten Abend 18:00', p9.k7 === '2026-10-02T18:00', p9.k7);
pruefe('keine Uhrzeit ueber 23:59', Object.values(p9).every((z) => /T([01][0-9]|2[0-3]):[0-5][0-9]$/.test(z)), Object.values(p9).join(' '));
pruefe('Schluss = Beginn bleibt abgelehnt',
  zpPruefeEinstellungen(Object.assign({}, opt, { tagesEnde: '14:00' })) !== '');
pruefe('kurz nach Mitternacht zu knapp wird abgefangen',
  zpPruefeEinstellungen(Object.assign({}, nacht, { startZeit: '23:30', tagesEnde: '00:15' })) !== '');

console.log('');
console.log(fehler ? fehler + ' Pruefung(en) fehlgeschlagen' : 'alle Pruefungen bestanden');
process.exit(fehler ? 1 : 0);
