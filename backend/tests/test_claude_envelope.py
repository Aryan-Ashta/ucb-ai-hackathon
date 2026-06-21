"""Unit tests for the JSON-envelope parser used by both extraction and grading.

These cover the edge cases the integration tests can't easily fake — fences
without a closing fence, partial JSON, "null", and wrong-shape payloads.
"""
from unittest.mock import patch

from backend.services.claude import _parse_json_envelope


@patch("backend.services.claude.sentry_sdk")
def test_strips_json_fences_and_parses_object(mock_sentry):
    out = _parse_json_envelope('```json\n{"quality": 4}\n```', breadcrumb_label="grade")
    assert out == {"quality": 4}
    mock_sentry.capture_exception.assert_not_called()


@patch("backend.services.claude.sentry_sdk")
def test_strips_plain_fences_and_parses_array(mock_sentry):
    out = _parse_json_envelope('```\n[{"a": 1}]\n```', breadcrumb_label="extract")
    assert out == [{"a": 1}]
    mock_sentry.capture_exception.assert_not_called()


@patch("backend.services.claude.sentry_sdk")
def test_handles_no_fences(mock_sentry):
    out = _parse_json_envelope('{"x": 1}', breadcrumb_label="grade")
    assert out == {"x": 1}


@patch("backend.services.claude.sentry_sdk")
def test_returns_none_on_malformed_json(mock_sentry):
    out = _parse_json_envelope("not json at all", breadcrumb_label="grade")
    assert out is None
    mock_sentry.capture_exception.assert_called_once()
    # breadcrumb label appears in the captured message
    call_args = mock_sentry.add_breadcrumb.call_args
    assert "grade" in call_args.kwargs["message"]


@patch("backend.services.claude.sentry_sdk")
def test_handles_partial_json(mock_sentry):
    out = _parse_json_envelope('{"quality": 4', breadcrumb_label="grade")
    assert out is None
    mock_sentry.capture_exception.assert_called_once()


@patch("backend.services.claude.sentry_sdk")
def test_handles_trailing_whitespace(mock_sentry):
    out = _parse_json_envelope('   {"x": 1}   \n\n', breadcrumb_label="grade")
    assert out == {"x": 1}


@patch("backend.services.claude.sentry_sdk")
def test_breadcrumb_label_is_propagated(mock_sentry):
    _parse_json_envelope("broken", breadcrumb_label="extract")
    msg = mock_sentry.add_breadcrumb.call_args.kwargs["message"]
    assert msg.startswith("JSON parse failed [extract]")
