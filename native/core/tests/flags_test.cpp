#include <lucent/core/flags.hpp>

namespace lucent {
namespace {

enum class permission : u8 { read = 0x01, write = 0x02, run = 0x80 };

enum class signed_permission : i8 { read = 0x01 };

constexpr flags<permission> read_write{permission::read, permission::write};

}

static_assert(flaggable<permission>, "an enum class over an unsigned type holds bits");
static_assert(!flaggable<signed_permission>, "a signed underlying type has a sign bit, not a flag");
static_assert(!flaggable<u8>, "a plain integer is not a set of named bits");

static_assert(flags<permission>{}.is_empty(), "a set built from nothing is empty");
static_assert(!read_write.is_empty(), "a set holding a value is not empty");

static_assert(read_write.has(permission::read), "a set has the values it was built from");
static_assert(read_write.has(permission::write), "a set has every value it was built from");
static_assert(!read_write.has(permission::run), "a set lacks values it was not built from");

static_assert(
    (read_write | permission::run).has(permission::run), "| adds a value, even the top bit"
);
static_assert(
    (flags{permission::read} | flags{permission::write}) == read_write, "| unites two sets"
);
static_assert((read_write | permission::read) == read_write, "adding a held value changes nothing");
static_assert(
    flags{permission::write, permission::read} == read_write, "the order values arrive in is moot"
);

static_assert(read_write.has_all(flags{permission::read}), "a set has all of a subset");
static_assert(read_write.has_all(flags<permission>{}), "a set has all of the empty set");
static_assert(
    !read_write.has_all(flags{permission::read, permission::run}), "has_all needs every value"
);

static_assert(read_write.has_any(flags{permission::run, permission::write}), "one shared is any");
static_assert(!read_write.has_any(flags{permission::run}), "no shared value is not any");
static_assert(!read_write.has_any(flags<permission>{}), "the empty set shares nothing");

static_assert(sizeof(flags<permission>) == sizeof(permission), "a set is as wide as its enum");

}
