#!/bin/sh
# Empaqueta la app Tizen (YTJam TV) en un .wgt
#
#   ./build.sh cert [perfil]   -> crea un certificado autofirmado y su perfil de firma
#   ./build.sh [perfil]        -> empaqueta y firma con ese perfil (por defecto: $TIZEN_PROFILE o 'ytjam')
#
# Requiere el CLI de Tizen Studio (tizen) en el PATH. Sin el CLI se genera un .wgt
# sin firmar, válido solo para inspección/emulador.
set -e

SRC="$(cd "$(dirname "$0")" && pwd)"
OUT="$SRC/../dist"
CERT_DIR="$SRC/.certs"
PROFILES_XML="${TIZEN_PROFILES_PATH:-$HOME/tizen-studio-data/profile/profiles.xml}"

# El CLI referencia ficheros .pwd cifrados que nunca llega a crear (y los reescribe
# tras cada firma), así que hay que dejar las contraseñas en línea antes de empaquetar:
# la del distribuidor del SDK es pública, y el marcador base64 del autor hace que el
# CLI pida la contraseña por consola en vez de abortar.
patch_profile() {
  PROFILE="$1" python3 - "$PROFILES_XML" <<'PY'
import os, sys, xml.etree.ElementTree as ET
path = sys.argv[1]
tree = ET.parse(path)
for profile in tree.getroot().findall('profile'):
    if profile.get('name') == os.environ['PROFILE']:
        for item in profile.findall('profileitem'):
            if item.get('distributor') == '0':
                item.set('password', 'AAAAAAAA')
            elif item.get('distributor') == '1':
                item.set('password', 'tizenpkcs12passfordsigner')
tree.write(path, encoding='UTF-8', xml_declaration=True)
PY
  chmod 600 "$PROFILES_XML"
}

# El CLI de Tizen no suele estar en el PATH y necesita un JDK
if ! command -v tizen >/dev/null 2>&1; then
  for d in "$HOME/tizen-studio" "$HOME/tizen-sdk" /opt/tizen-studio; do
    if [ -x "$d/tools/ide/bin/tizen" ]; then
      PATH="$d/tools/ide/bin:$d/tools:$PATH"
      export PATH
      break
    fi
  done
fi
if [ -z "$JAVA_HOME" ] && ! command -v java >/dev/null 2>&1; then
  for j in "$HOME"/opt/jdk-*; do
    if [ -x "$j/bin/java" ]; then
      JAVA_HOME="$j"
      PATH="$JAVA_HOME/bin:$PATH"
      export JAVA_HOME PATH
      break
    fi
  done
fi

if [ "$1" = "cert" ]; then
  shift
  PROFILE="${1:-${TIZEN_PROFILE:-ytjam}}"
  command -v tizen >/dev/null 2>&1 || { echo "Falta el CLI de Tizen Studio." >&2; exit 1; }

  # La contraseña nunca se pasa por argumentos del script: se pide aquí o vía entorno
  if [ -z "$TIZEN_CERT_PASSWORD" ]; then
    printf 'Contraseña para el certificado: '
    stty -echo 2>/dev/null || true
    read -r TIZEN_CERT_PASSWORD
    stty echo 2>/dev/null || true
    printf '\n'
  fi

  mkdir -p "$CERT_DIR"
  mkdir -p "$(dirname "$PROFILES_XML")"
  tizen cli-config "default.profiles.path=$PROFILES_XML" >/dev/null

  tizen certificate -a "$PROFILE" -p "$TIZEN_CERT_PASSWORD" -f "$PROFILE" -- "$CERT_DIR"
  tizen security-profiles add -n "$PROFILE" -a "$CERT_DIR/$PROFILE.p12" -p "$TIZEN_CERT_PASSWORD" -A -f
  chmod 600 "$CERT_DIR/$PROFILE.p12"

  if command -v openssl >/dev/null 2>&1; then
    # OpenSSL 3 necesita -legacy para los p12 que genera Tizen (RC2/3DES)
    if TIZEN_CERT_PASSWORD="$TIZEN_CERT_PASSWORD" openssl pkcs12 -legacy -in "$CERT_DIR/$PROFILE.p12" -passin env:TIZEN_CERT_PASSWORD -noout 2>/dev/null \
       || TIZEN_CERT_PASSWORD="$TIZEN_CERT_PASSWORD" openssl pkcs12 -in "$CERT_DIR/$PROFILE.p12" -passin env:TIZEN_CERT_PASSWORD -noout 2>/dev/null; then
      echo "Certificado verificado con la contraseña introducida."
    else
      echo "El .p12 no se abre con esa contraseña; usa una sin espacios ni caracteres raros." >&2
      exit 1
    fi
  fi

  patch_profile "$PROFILE"

  echo "Perfil de firma '$PROFILE' listo (certificado en $CERT_DIR)."
  echo "Ahora: ./build.sh $PROFILE"
  echo "Cada build pedirá la contraseña y preguntará 'Save author password'; responde Y."
  exit 0
fi

PROFILE="${1:-${TIZEN_PROFILE:-ytjam}}"

mkdir -p "$OUT"
rm -f "$OUT"/YTJamTV*.wgt

if command -v tizen >/dev/null 2>&1; then
  grep -q "name=\"$PROFILE\"" "$PROFILES_XML" 2>/dev/null || {
    echo "El perfil '$PROFILE' no existe en $PROFILES_XML. Ejecuta: ./build.sh cert $PROFILE" >&2
    exit 1
  }
  tizen cli-config "default.profiles.path=$PROFILES_XML" >/dev/null
  patch_profile "$PROFILE"

  # 'tizen build-web' falla en la instalación web-cli, así que se empaqueta un stage limpio
  STAGE="$SRC/.stage"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  cp "$SRC/config.xml" "$SRC/index.html" "$SRC/icon.png" "$STAGE/"
  tizen package -t wgt -s "$PROFILE" -o "$OUT" -- "$STAGE"
  rm -rf "$STAGE"
  # el CLI nombra el .wgt con <name> del config.xml (con espacios)
  for f in "$OUT"/*.wgt; do
    [ "$f" = "$OUT/YTJamTV.wgt" ] || mv "$f" "$OUT/YTJamTV.wgt"
  done
  python3 -c "import sys,zipfile;n=zipfile.ZipFile(sys.argv[1]).namelist();sys.exit(0 if 'author-signature.xml' in n and 'signature1.xml' in n else 1)" "$OUT/YTJamTV.wgt" || {
    echo "El .wgt se generó SIN FIRMA; revisa el perfil '$PROFILE'." >&2
    exit 1
  }
  echo "WGT firmado en: $OUT/YTJamTV.wgt"
  echo "Instalar en la TV (modo desarrollador):"
  echo "  sdb connect <ip-de-la-tv>"
  echo "  tizen install -n YTJamTV.wgt -- \"$OUT\""
else
  echo "AVISO: no se encontró el CLI de Tizen; se generará un .wgt SIN FIRMAR." >&2
  if command -v zip >/dev/null 2>&1; then
    (cd "$SRC" && zip -r -q "$OUT/YTJamTV-unsigned.wgt" config.xml index.html icon.png)
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$SRC" "$OUT/YTJamTV-unsigned.wgt" <<'PY'
import sys, zipfile, os
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for name in ('config.xml', 'index.html', 'icon.png'):
        z.write(os.path.join(src, name), name)
PY
  else
    echo "Falta 'zip' o 'python3' para empaquetar." >&2
    exit 1
  fi
  echo "WGT sin firmar en: $OUT/YTJamTV-unsigned.wgt"
fi
