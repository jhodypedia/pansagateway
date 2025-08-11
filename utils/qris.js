// utils/qris.js
// build QRIS payload (expects base payload contains {AMOUNT_FIELD})
function crc16CcittFalse(input) {
  const poly = 0x1021;
  let crc = 0xFFFF;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) crc = ((crc << 1) & 0xFFFF) ^ poly;
      else crc = (crc << 1) & 0xFFFF;
    }
  }
  return crc & 0xFFFF;
}
function toHex4(n) { return n.toString(16).toUpperCase().padStart(4,'0'); }

export function buildQrisPayload(basePayload, amountNumber) {
  const amtStr = String(amountNumber);
  const amtField = '54' + String(amtStr.length).padStart(2,'0') + amtStr;
  const payloadWithoutCRC = basePayload.replace('{AMOUNT_FIELD}', amtField);
  const crcInput = payloadWithoutCRC + '6304';
  const crc = toHex4(crc16CcittFalse(crcInput));
  return payloadWithoutCRC + crc;
}
