"""Entry point for the Foundry Agent Playground."""

import uvicorn
from backend.config import PORT

if __name__ == "__main__":
    uvicorn.run("backend.app:app", host="0.0.0.0", port=PORT, reload=True)
