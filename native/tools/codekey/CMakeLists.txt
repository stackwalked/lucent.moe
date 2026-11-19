lucent_executable(codekey
    SOURCES
        src/main.cpp
        src/cli/options.cpp
        src/key/key_file.cpp
        src/key/passphrase.cpp
        src/key/random.cpp
    DEPS lucent::bundle lucent::crypto lucent::os lucent::wire bcrypt
)
