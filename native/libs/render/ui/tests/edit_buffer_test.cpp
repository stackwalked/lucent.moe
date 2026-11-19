#include <lucent/ui/edit_buffer.hpp>

#include <string>
#include <string_view>

#include <catch2/catch_test_macros.hpp>

namespace lucent::ui {
namespace {

auto typed_into(edit_buffer& buffer, std::string_view utf8) -> void {
    for (const char unit : utf8) {
        buffer.insert(std::string{unit});
    }
}

TEST_CASE("typing undoes a word at a time, and redo brings it back") {
    edit_buffer buffer{""};
    typed_into(buffer, "hello world");
    REQUIRE(buffer.text() == "hello world");

    buffer.undo();
    CHECK(buffer.text() == "hello ");
    buffer.undo();
    CHECK(buffer.text().empty());
    buffer.redo();
    buffer.redo();
    CHECK(buffer.text() == "hello world");
    CHECK(buffer.selection() == text_selection{.anchor = 11, .caret = 11});
}

TEST_CASE("an edit after an undo drops what redo would have brought back") {
    edit_buffer buffer{""};
    typed_into(buffer, "ab");
    buffer.undo();
    buffer.insert("c");
    buffer.redo();
    CHECK(buffer.text() == "c");
}

TEST_CASE("a paste replaces the selection and undoes on its own") {
    edit_buffer buffer{"one two"};
    buffer.select_word_at(5);
    REQUIRE(buffer.selected() == "two");
    buffer.paste("three");
    CHECK(buffer.text() == "one three");
    buffer.undo();
    CHECK(buffer.text() == "one two");
    CHECK(buffer.selected() == "two");
}

TEST_CASE("the caret steps over whole code points, never into one") {
    // "a", e acute (2 bytes), a grinning face (4 bytes).
    edit_buffer buffer{"a\xC3\xA9\xF0\x9F\x98\x80"};
    buffer.move_caret(-1, caret_step::character, selection_mode::move);
    CHECK(buffer.selection().caret == 3);
    buffer.erase_backward(caret_step::character);
    CHECK(buffer.text() == "a\xF0\x9F\x98\x80");
    buffer.move_to(3, selection_mode::move);
    CHECK(buffer.selection().caret == 1);
}

TEST_CASE("word steps land on word starts going back and past the gap going on") {
    edit_buffer buffer{"alpha, beta gamma"};
    buffer.move_caret(-1, caret_step::word, selection_mode::move);
    CHECK(buffer.selection().caret == 12);
    buffer.move_caret(-1, caret_step::word, selection_mode::move);
    CHECK(buffer.selection().caret == 7);
    buffer.move_caret(-1, caret_step::word, selection_mode::extend);
    CHECK(buffer.selected() == "alpha, ");
    buffer.move_to(0, selection_mode::move);
    buffer.move_caret(1, caret_step::word, selection_mode::move);
    CHECK(buffer.selection().caret == 7);
}

TEST_CASE("erasing a word back from the caret leaves the gap before it") {
    edit_buffer buffer{"one two"};
    buffer.erase_backward(caret_step::word);
    CHECK(buffer.text() == "one ");
    buffer.move_to(0, selection_mode::move);
    buffer.erase_forward(caret_step::word);
    CHECK(buffer.text().empty());
}

TEST_CASE("moving without shift out of a selection lands on its edge") {
    edit_buffer buffer{"abcdef"};
    buffer.move_to(1, selection_mode::move);
    buffer.move_to(4, selection_mode::extend);
    buffer.move_caret(-1, caret_step::character, selection_mode::move);
    CHECK(buffer.selection() == text_selection{.anchor = 1, .caret = 1});
}

TEST_CASE("a text changed from outside resets the history and puts the caret at its end") {
    edit_buffer buffer{""};
    typed_into(buffer, "longer text");
    buffer.move_to(2, selection_mode::move);
    buffer.reset("short");
    CHECK(buffer.selection() == text_selection{.anchor = 5, .caret = 5});
    buffer.undo();
    CHECK(buffer.text() == "short");
}

}
}
