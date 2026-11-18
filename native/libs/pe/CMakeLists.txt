lucent_library(pe
    HEADERS
        include/lucent/pe/exports.hpp
        include/lucent/pe/image_view.hpp
        include/lucent/pe/imports.hpp
        include/lucent/pe/relocations.hpp
        include/lucent/pe/tls.hpp
    SOURCES
        src/exports.cpp
        src/image_view.cpp
        src/imports.cpp
        src/relocations.cpp
        src/tls.cpp
)

lucent_test(pe
    SOURCES tests/corruption_test.cpp tests/image_view_test.cpp tests/images.cpp
    DEPS lucent::os
)
