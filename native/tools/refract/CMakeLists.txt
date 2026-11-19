lucent_library(refract
    HEADERS
        include/lucent/refract/execution.hpp
        include/lucent/refract/function.hpp
        include/lucent/refract/instruction.hpp
        include/lucent/refract/machine.hpp
        include/lucent/refract/operation.hpp
        include/lucent/refract/refusal.hpp
        include/lucent/refract/width.hpp
    SOURCES
        src/execution.cpp
        src/function.cpp
        src/instruction.cpp
        src/machine.cpp
    DEPS Zydis::Zydis
)

lucent_test(refract
    SOURCES
        tests/assembler.cpp
        tests/function_test.cpp
        tests/native_cpu.cpp
        tests/refusal_test.cpp
        tests/semantics_test.cpp
)
