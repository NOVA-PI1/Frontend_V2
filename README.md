# NOVA Frontend V2

Frontend React + TypeScript para NOVA, con diseño tipo Claude/ChatGPT, sesiones persistentes y trazas en vivo desde Socket.IO.

## Stack

- React 18
- Vite
- TypeScript
- Socket.IO Client

## Variables de entorno

Crea un archivo `.env` con este contenido:

```env
VITE_API_BASE_URL=http://localhost:8000
VITE_SOCKET_URL=http://localhost:8000
```

## Arranque local

```bash
npm install
npm run dev
```

## Flujo que consume del backend

- `GET /health`
- `GET /sessions`
- `GET /session/{session_id}`
- `POST /session`
- Evento Socket.IO `agent_event`

## Siguiente paso recomendado

1. Conectar autenticación si el backend la tiene activa.
2. Separar la vista en componentes y agregar historial/edición de canvas.
3. Agregar streaming incremental si el backend expone fragmentos más finos.