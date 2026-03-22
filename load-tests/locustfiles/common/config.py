"""Configuration management for load tests."""
import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    """Load test configuration.
    
    Uses api-staging.shogo.ai for direct API access (bypasses studio proxy).
    The app frontend may use a shared host with same-origin /api/* calls,
    but load tests hit the API DomainMapping directly for accurate latency measurement.
    """
    
    # Target URLs
    API_BASE_URL = os.getenv("API_BASE_URL", "https://api-staging.shogo.ai")
    WEB_BASE_URL = os.getenv("WEB_BASE_URL", "https://app.example.com")
    
    # Test settings
    NUM_USERS = int(os.getenv("NUM_USERS", "100"))
    SPAWN_RATE = int(os.getenv("SPAWN_RATE", "10"))
    RUN_TIME = os.getenv("RUN_TIME", "10m")
    
    # Test credentials
    TEST_USER_PREFIX = os.getenv("TEST_USER_PREFIX", "loadtest-user")
    TEST_USER_PASSWORD = os.getenv("TEST_USER_PASSWORD", "LoadTest123!")
    
    # Load test bypass key (skips rate limiting when set on both client and server)
    LOAD_TEST_SECRET = os.getenv("LOAD_TEST_SECRET", "")

    # Host header override -- when targeting a direct IP (e.g. region Kourier LB),
    # set this to the real hostname (e.g. "studio.shogo.ai") so the server
    # recognises the request and Knative routes it correctly.
    HOST_HEADER = os.getenv("HOST_HEADER", "")

    # Per-region user ID range to avoid signup collisions across parallel instances
    USER_ID_MIN = int(os.getenv("USER_ID_MIN", "200000"))
    USER_ID_MAX = int(os.getenv("USER_ID_MAX", "999999"))

    # Thresholds
    MAX_RESPONSE_TIME_P95 = int(os.getenv("MAX_RESPONSE_TIME_P95", "2000"))
    MAX_RESPONSE_TIME_P99 = int(os.getenv("MAX_RESPONSE_TIME_P99", "5000"))
    MAX_ERROR_RATE = float(os.getenv("MAX_ERROR_RATE", "0.01"))
    
    # Cleanup
    CLEANUP_AFTER_TEST = os.getenv("CLEANUP_AFTER_TEST", "true").lower() == "true"

    # Admin credentials for cleanup script
    ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "")
    ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")


config = Config()
