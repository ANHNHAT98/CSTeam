const crypto = require('crypto');

/**
 * Port chính xác của HQ.eSkyFramework.Encryption (dùng trong DecryptPassHQsoft.exe).
 * Đã đối chiếu bằng cách chạy trực tiếp DLL gốc qua Mono — kết quả khớp 100%
 * cho nhiều test case khác nhau trước khi đưa vào đây.
 *
 * Thuật toán (suy ra từ IL của HQ.eSkyFramework.dll):
 *   - salt = UTF8 bytes của chính "password" (key hệ thống)
 *   - derive 48 byte qua PBKDF2 (Rfc2898DeriveBytes mặc định .NET Framework:
 *     HMAC-SHA1, 1000 vòng lặp) — 32 byte đầu = AES Key, 16 byte kế = IV
 *   - AES-256-CBC, PKCS7 padding
 *   - Encrypt: input UTF8 -> AES encrypt -> Base64
 *   - Decrypt: input Base64 -> AES decrypt -> UTF8
 *
 * Key hệ thống lấy đúng từ Form1.GetPassword() trong DecryptPassHQsoft.exe
 * (hardcode sẵn trong file gốc, không phải bí mật do người dùng tự đặt).
 */
const SYSTEM_KEY = '1210Hq10s081f359t';

function deriveKeyIv(password) {
  const salt = Buffer.from(password, 'utf8');
  const derived = crypto.pbkdf2Sync(password, salt, 1000, 48, 'sha1');
  return { key: derived.subarray(0, 32), iv: derived.subarray(32, 48) };
}

function hqEncrypt(plainText, password = SYSTEM_KEY) {
  const { key, iv } = deriveKeyIv(password);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plainText, 'utf8')), cipher.final()]);
  return encrypted.toString('base64');
}

function hqDecrypt(cipherText, password = SYSTEM_KEY) {
  const { key, iv } = deriveKeyIv(password);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { hqEncrypt, hqDecrypt, SYSTEM_KEY };
