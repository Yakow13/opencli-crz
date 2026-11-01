/**
 * Minimal STORED-entry ZIP writer for tests (method 0, no compression).
 * Independent of the adapter's reader; readZip itself is validated against
 * REAL CRZ archives in changes.test.js — this only feeds sync-level fixtures.
 */
export function makeStoredZip(name, text) {
    const body = Buffer.from(text, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 10);                    // stored
    local.writeUInt32LE(0, 14);                    // crc ignored by our reader
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localHeader = Buffer.concat([local, nameBuf, body]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 42);                  // local header offset
    const centralDir = Buffer.concat([central, nameBuf]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(centralDir.length, 12);
    eocd.writeUInt32LE(localHeader.length, 16);
    return Buffer.concat([localHeader, centralDir, eocd]);
}

export const DAY1_XML = '<?xml version="1.0" encoding="UTF-8"?><zmluvy>'
    + '<zmluva><nazov>Zmluva A</nazov><ID>9000001</ID><zs1>Obec One</zs1><zs2>Firm s.r.o.</zs2>'
    + '<predmet>Predmet A</predmet><datum_ucinnost>2026-01-02</datum_ucinnost><datum_platnost_do>0000-00-00</datum_platnost_do>'
    + '<suma_zmluva>1000.00</suma_zmluva><suma_spolu>1000.00</suma_spolu><rezort>114495</rezort>'
    + '<datum_zverejnene>2026-01-02 09:00:00</datum_zverejnene><ico>11111111</ico><stav>2</stav>'
    + '<sidlo>Cesta 1, One</sidlo><ico1>00000001</ico1><sidlo1>Namestie 2, One</sidlo1>'
    + '<datum>2026-01-01</datum><druh>1</druh><crzid>9000001</crzid><chan>2026-01-02 09:00:00</chan>'
    + '<prilohy><priloha><ID>9100001</ID><nazov>zmluva_a</nazov><dokument1>1.pdf</dokument1><velkost1>5</velkost1></priloha></prilohy></zmluva>'
    + '<zmluva><nazov>Dodatok B</nazov><ID>9000002</ID><zs1>Obec One</zs1><zs2>Firm s.r.o.</zs2>'
    + '<predmet>Dodatok k A</predmet><suma_zmluva>1000.00</suma_zmluva><suma_spolu>1500.00</suma_spolu>'
    + '<datum_zverejnene>2026-01-02 10:00:00</datum_zverejnene><ico></ico><ico1>00000001</ico1><stav>2</stav>'
    + '<datum>2026-01-02</datum><crzid>9000002</crzid><chan>2026-01-02 10:00:00</chan></zmluva>'
    + '</zmluvy>';

export const DAY2_XML = '<?xml version="1.0" encoding="UTF-8"?><zmluvy>'
    + '<zmluva><nazov>Zmluva A</nazov><ID>9000001</ID><zs1>Obec One</zs1><zs2>Firm s.r.o.</zs2>'
    + '<predmet>Predmet A</predmet><suma_zmluva>1000.00</suma_zmluva><suma_spolu>2500.00</suma_spolu>'
    + '<datum_zverejnene>2026-01-02 09:00:00</datum_zverejnene><ico>11111111</ico><ico1>00000001</ico1>'
    + '<stav>2</stav><datum>2026-01-01</datum><crzid>9000001</crzid><chan>2026-01-03 08:00:00</chan></zmluva>'
    + '</zmluvy>';
