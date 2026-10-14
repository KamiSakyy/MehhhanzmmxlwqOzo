# ============================================================================
#  Нативная часть движка: libmmxsec.so (крипто + JNI + ключ в .so).
# ============================================================================
cmake_minimum_required(VERSION 3.22.1)
project(mmxsec CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)

get_filename_component(MMX_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../.." ABSOLUTE)

if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/generated/mmx_keys_generated.cpp")
    message(FATAL_ERROR "Нет сгенерированного ключа. Запустите: python3 tools/ci/genkey.py")
endif()

add_library(mmxsec SHARED
    mmx_jni.cpp
    ${MMX_ROOT}/native/crypto/mmx_crypto.cpp
    generated/mmx_keys_generated.cpp
)

target_include_directories(mmxsec PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${MMX_ROOT}/native/crypto
)

find_library(log-lib log)
target_link_libraries(mmxsec PRIVATE ${log-lib})

target_compile_options(mmxsec PRIVATE -O2 -fstack-protector-strong -fvisibility=hidden -Wall)

set_target_properties(mmxsec PROPERTIES OUTPUT_NAME mmxsec)
