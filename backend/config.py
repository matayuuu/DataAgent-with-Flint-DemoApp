import os
from dotenv import load_dotenv

load_dotenv()

PROJECT_ENDPOINT = os.getenv("PROJECT_ENDPOINT", "")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "gpt-4o-mini")
PORT = int(os.getenv("PORT", "8000"))
