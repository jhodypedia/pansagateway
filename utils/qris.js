// utils/qris.js
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

function toHex4(n) {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

export function buildQrisPayload(basePayload, amountNumber) {
  // Format nominal jadi 2 digit desimal
  const amtStr = parseFloat(amountNumber).toFixed(2);
  const amtField = '54' + String(amtStr.length).padStart(2, '0') + amtStr;

  // Sisipkan nominal
  const payloadWithoutCRC = basePayload.replace('{AMOUNT_FIELD}', amtField);

  // Hitung CRC
  const crcInput = payloadWithoutCRC + '6304';
  const crc = toHex4(crc16CcittFalse(crcInput));

  // Gabungkan CRC
  return payloadWithoutCRC + crc;
}
