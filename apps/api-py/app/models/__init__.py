# Importing the model modules registers them on Base.metadata (for create_all
# and Alembic autogenerate). Add new model modules here as the schema grows.
from . import academics  # noqa: F401
from . import profile  # noqa: F401
from . import user  # noqa: F401
