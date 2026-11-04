# BacklogMGR

Gestor personal de backlog de videojuegos. Web instalable (PWA): funciona en Android y en PC, y sin conexión una vez cargada.

## Qué hace

- Seis listas: Jugando, Backlog, Deseados, En espera, Abandonados y Completados.
- Tarjetas con portada, plataforma y barra de progreso arrastrable. «Jugar» / «Completar» / «Rejugar» con un toque.
- Fechas de inicio y fin automáticas, valoración de 1 a 5 estrellas, nota de cierre, veces completado, etiquetas y duración estimada.
- Más de 90 plataformas en un desplegable alfabético (consolas desde NES y Game Boy, arcade, Steam Deck, Steam Machine…) y opción de escribir una propia.
- Búsqueda de juegos y portadas con SteamGridDB (tu clave personal). La portada solo se cambia desde SteamGridDB: toca la imagen en la ficha del juego y, si no es el juego correcto, busca otro dentro del selector.
- «¿A qué juego ahora?» (dado), estadísticas, filtros y buscador.
- **Sincronización entre dispositivos** con un código y cifrado de extremo a extremo (ver abajo).
- **Mi orden:** en el selector de orden, «Mi orden» muestra una lista compacta donde arrastras (⠿) para priorizar tu cola; el primero del backlog lleva la etiqueta «Siguiente», y ⤒ sube un juego al principio.
- **Selección múltiple:** el botón «Seleccionar» junto al título de la lista permite mover o eliminar varios juegos a la vez.
- **Reto anual y resumen del año** (en Estadísticas): pon una meta de juegos completados, mira cómo vas y genera una imagen con tu año para guardar o compartir. El reto se sincroniza.
- **Papelera de 30 días** con «Deshacer» al eliminar; se restaura desde Ajustes → Datos y copias.
- **Versiones de la nube:** una copia diaria durante 14 días; recupera juegos borrados o vuelve a cómo estaba la lista.
- **Tema** automático, oscuro o claro; **copiar tus listas como texto**; aviso si añades un juego que ya tienes.
- **Idioma** español o inglés (Ajustes → Apariencia). **Valoración con medias estrellas** (toca la mitad izquierda de la estrella) y orden por valoración. **Cada lista recuerda su propio orden** (por defecto: en espera A–Z, completados por valoración, el resto recientes). «Añadir a» parte de la lista en la que estás.
- **Plataformas desde HowLongToBeat:** al buscar un juego para añadirlo, bajo cada resultado salen sus plataformas (las que HowLongToBeat conoce y existen en tu lista); toca una para añadirlo con ella. Si solo tiene una, se elige sola. Incluye «Móvil».
- **Orden ↑/↓** en cada panel (botón junto al selector), **filtro por duración**, «Todas las plataformas», **horas que quedan** en los juegos que estás jugando, lista de los juegos sin duración tras «Buscar horas de todos» y **«¿A qué juego ahora?»** con filtros propios (lista, plataforma, duración y etiqueta).
- **Duración automática (HowLongToBeat):** al añadir un juego se buscan sus horas (historia, extras y completista) a través de tu Worker. En Ajustes → Duración eliges cuál prefieres; si falta, con un solo dato se usa ese y con dos, el más grande si prefieres «Completista» y el más pequeño en los otros casos. Lo que escribas a mano manda, salvo que marques «sobrescribir». Hay un botón para buscar las horas de todos los juegos (no completados), un selector de resultados en cada juego, orden por duración y un botón «Probar HowLongToBeat» que dice dónde falla si algún día deja de responder. **Requiere pegar de nuevo el `worker.js` en Cloudflare.** HowLongToBeat no tiene API oficial y puede cambiar su web.
- Las fechas de inicio y fin de un juego se pueden quitar desde sus detalles.
- Exportar e importar copia de seguridad.
- Botón «atrás» del móvil: cierra la ventana abierta y, si no hay ninguna, lleva al inicio (Jugando).

## Instalación y actualización

Sube **todos los archivos de esta carpeta** a la raíz del repositorio de GitHub (Add file → Upload files; los que ya existen se sobrescriben) y confirma con *Commit changes*. La app se recarga sola con la versión nueva.

Si la publicas en Cloudflare conectada al repositorio, se actualiza sola con cada cambio.

## Worker de Cloudflare (proxy de SteamGridDB + sincronización)

Un único Worker hace las dos cosas. Si ya tienes uno funcionando como proxy (`backlog-proxy`), solo hay que actualizarlo y darle almacenamiento:

1. **Crear el almacén KV.** Cloudflare → *Storage & Databases* → *KV* → *Create* → nombre `backlogmgr-sync`. (Los nombres de los menús pueden variar un poco.)
2. **Actualizar el código.** *Workers & Pages* → tu Worker → *Edit code* → borra todo y pega el contenido de `worker.js` → *Deploy*.
   - Revisa la lista `ALLOWED_ORIGINS` al principio: debe contener la dirección desde la que abres la app (solo `https://dominio`, sin barra final ni ruta).
   - Si ya tenías el Worker de una versión anterior, **vuelve a pegar este `worker.js` completo**: añade las copias diarias de la nube. Sin eso, todo lo demás funciona, pero «Versiones anteriores» avisará de que el Worker es antiguo.
3. **Enlazar el KV.** En la pantalla del Worker, tarjeta *Bindings* → *Add* → *KV namespace* → nombre de variable **`SYNC`** (en mayúsculas, exacto) → elige `backlogmgr-sync` → guardar y desplegar.

La dirección del Worker **ya viene escrita en la app** (constante `DEFAULT_PROXY` de `index.html`, ahora `https://backlog-proxy.backlogmgr.workers.dev/?url=`), así que no hay que configurarla en cada dispositivo. Si algún día cambias de Worker o del subdominio de `workers.dev`, cámbiala en esa línea y sube el archivo, o escríbela en Ajustes → «Dirección del Worker». La sincronización usa ese mismo Worker.

## Sincronizar móvil y PC

1. En el primer dispositivo: Ajustes → *Sincronización* → **Crear código nuevo**. Se sube todo a la nube.
2. En el segundo: Ajustes → **Ya tengo un código** → escríbelo (da igual mayúsculas, guiones o espacios) → *Conectar*.
   - Más cómodo: en el primero pulsa **Copiar enlace para otro dispositivo**, mándatelo (por ejemplo por mensaje a ti mismo) y ábrelo en el segundo. Conecta el código de un toque.
3. Desde ahí es automático: se sincroniza al abrir la app, al volver a ella, unos segundos después de cada cambio y cada ~40 segundos mientras la tienes a la vista, de modo que los cambios del otro dispositivo aparecen solos, sin refrescar. El punto de color del icono de ajustes indica el estado (verde correcto, ámbar sincronizando, rojo error).

Cómo funciona y qué garantiza:
- Los juegos se **cifran en tu dispositivo** (AES-256) con una clave derivada de tu código. El Worker solo guarda texto ilegible bajo un identificador derivado del código, y nunca ve tus juegos ni el código.
- El código tiene 125 bits de azar: no se puede adivinar. **Quien lo tenga puede leer y cambiar tus datos; si lo pierdes junto con todos tus dispositivos, no hay forma de recuperar la nube.** Guárdalo en un gestor de contraseñas.
- Cada día, la primera sincronización guarda en la nube una copia de cómo estaba antes de subir cambios (caduca a los 14 días). Se usa en Ajustes → Sincronización → «Versiones anteriores de la nube». Cuesta una escritura más al día en KV.
- Cuando dos dispositivos cambian el mismo juego, gana el cambio más reciente de ese juego. Lo demás se une. Los borrados también se sincronizan.
- La clave de SteamGridDB **no** se sincroniza y no debe ir en el repositorio: se pone en cada dispositivo.
- Las portadas son enlaces de SteamGridDB, así que casi no pesan. Hay un límite de 8 MB de datos.
- La papelera también se sincroniza: un juego eliminado en un dispositivo aparece en la papelera de los demás, con sus datos, durante 30 días.
- *Desconectar este dispositivo* (dentro de «Opciones avanzadas») deja de sincronizar pero conserva tus juegos. *Borrar datos de la nube* elimina la copia en la nube y desconecta este dispositivo; otros dispositivos con el mismo código la volverían a crear al sincronizar.

## Dominio propio (p. ej. backlogmgr.app)

La app se puede servir desde una dirección propia. Como los datos locales se guardan por dirección, lo cómodo es **sincronizar antes de cambiar**: al abrir la app en la dirección nueva, conectas con el código (o con el enlace) y vuelve todo.

1. Añade la dirección nueva a `ALLOWED_ORIGINS` del Worker (este `worker.js` ya incluye `https://backlogmgr.github.io`; si compras un dominio propio, añádelo también).
2. Conéctalo a la app (con Cloudflare: *Workers & Pages* → el Worker que sirve la app → *Settings* → *Domains & Routes* → *Add* → *Custom domain*; con GitHub Pages: *Settings → Pages → Custom domain* y registros DNS).
3. En el móvil, reinstala la app desde la dirección nueva.

## Configurar SteamGridDB

1. Consigue tu clave en https://www.steamgriddb.com/profile/preferences/api
2. En la app: Ajustes → pégala → **Probar conexión**. Si falla, comprueba que el Worker esté desplegado y que la dirección desde la que abres la app esté en `ALLOWED_ORIGINS` del Worker.

La clave se guarda solo en tu navegador. No la subas al repositorio.

## Pendiente

Importar CSV, consulta automática de duraciones (HowLongToBeat no tiene API oficial) y, más adelante, cuentas con inicio de sesión. La integración con tu cuenta de Backloggd queda descartada: no ofrece API ni exportación oficial.
