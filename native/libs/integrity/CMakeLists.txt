lucent_library(integrity
    HEADERS
        include/lucent/integrity/boot_state.hpp
        include/lucent/integrity/code_pages.hpp
        include/lucent/integrity/debugging.hpp
        include/lucent/integrity/expected_bytes.hpp
        include/lucent/integrity/hash_challenge.hpp
        include/lucent/integrity/module_census.hpp
        include/lucent/integrity/observation.hpp
        include/lucent/integrity/vm_vendor.hpp
    SOURCES
        src/boot_state.cpp
        src/code_pages.cpp
        src/debugging.cpp
        src/expected_bytes.cpp
        src/hash_challenge.cpp
        src/module_census.cpp
        src/signer.cpp
        src/vm_vendor.cpp
    DEPS lucent::crypto lucent::os lucent::pe
)
target_link_libraries(lucent_integrity PRIVATE ntdll wintrust crypt32)

lucent_test(integrity
    SOURCES
        tests/boot_state_test.cpp
        tests/code_pages_test.cpp
        tests/debugging_test.cpp
        tests/fixture.cpp
        tests/hash_challenge_test.cpp
        tests/module_census_test.cpp
        tests/vm_vendor_test.cpp
)
lucent_fixture(integrity image SOURCES tests/fixtures/image.cpp)
