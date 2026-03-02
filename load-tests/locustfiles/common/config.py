"""Configuration management for load tests."""
import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    """Load test configuration."""
    
    # Target URLs
    API_BASE_URL = os.getenv("API_BASE_URL", "https://api-staging.shogo.ai")
    MCP_BASE_URL = os.getenv("MCP_BASE_URL", "https://mcp-staging.shogo.ai")
    WEB_BASE_URL = os.getenv("WEB_BASE_URL", "https://studio-staging.shogo.ai")
    
    # Test settings
    NUM_USERS = int(os.getenv("NUM_USERS", "100"))
    SPAWN_RATE = int(os.getenv("SPAWN_RATE", "10"))
    RUN_TIME = os.getenv("RUN_TIME", "10m")
    
    # Test credentials
    TEST_USER_PREFIX = os.getenv("TEST_USER_PREFIX", "loadtest-user")
    TEST_USER_PASSWORD = os.getenv("TEST_USER_PASSWORD", "LoadTest123!")
    
    # Thresholds
    MAX_RESPONSE_TIME_P95 = int(os.getenv("MAX_RESPONSE_TIME_P95", "2000"))
    MAX_RESPONSE_TIME_P99 = int(os.getenv("MAX_RESPONSE_TIME_P99", "5000"))
    MAX_ERROR_RATE = float(os.getenv("MAX_ERROR_RATE", "0.01"))
    
    # Cleanup
    CLEANUP_AFTER_TEST = os.getenv("CLEANUP_AFTER_TEST", "true").lower() == "true"


config = Config()
