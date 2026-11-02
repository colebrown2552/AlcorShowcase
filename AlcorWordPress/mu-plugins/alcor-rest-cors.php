<?php
/**
 * Plugin Name: Alcor REST CORS
 * Description: Sends REST API CORS headers only for the site's own origin; never reflects a third-party origin together with credentials.
 * Version: 1.0.0
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * Author: Alcor Industries
 *
 * WordPress core's rest_send_cors_headers() echoes any request Origin back in Access-Control-Allow-Origin together
 * with Access-Control-Allow-Credentials: true. That lets a page on any other site make credentialed REST calls with
 * a visitor's cookies, and read the answers. This plugin replaces that callback so the core headers are sent only
 * when the Origin is the site's own scheme://host:port (home_url()). Any other Origin gets no Allow-Origin and no
 * Allow-Credentials header at all. Requests without an Origin header, and response bodies and status codes, are
 * left alone.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Reduces a URL to scheme://host:port with the default port made explicit.
 *
 * Origins are compared as whole tuples, so "https://example.com" and "https://example.com:443" are the same origin
 * and "https://example.com.evil.test" is not.
 *
 * @param string $url A URL or an Origin header value.
 * @return string The normalised origin, or '' when the value is not an http(s) URL with a host.
 */
function alcor_rest_cors_normalize_origin( string $url ): string {
	$parts = wp_parse_url( $url );
	if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
		return '';
	}
	$scheme = strtolower( (string) $parts['scheme'] );
	// A trailing dot names the same host ("example.com.").
	$host = rtrim( strtolower( (string) $parts['host'] ), '.' );
	if ( '' === $host ) {
		return '';
	}
	if ( ! empty( $parts['port'] ) ) {
		$port = (int) $parts['port'];
	} elseif ( 'https' === $scheme ) {
		$port = 443;
	} elseif ( 'http' === $scheme ) {
		$port = 80;
	} else {
		return '';
	}
	return $scheme . '://' . $host . ':' . $port;
}

/**
 * Tells whether an Origin header value is the site's own origin.
 *
 * @param string $origin The request's Origin header.
 * @return bool True only for the origin of home_url(). "null" (sandboxed and file:// pages) is never trusted.
 */
function alcor_rest_cors_origin_is_trusted( string $origin ): bool {
	if ( '' === $origin || 'null' === strtolower( $origin ) ) {
		return false;
	}
	$normalized = alcor_rest_cors_normalize_origin( $origin );
	return '' !== $normalized && alcor_rest_cors_normalize_origin( home_url( '/' ) ) === $normalized;
}

/**
 * Drop-in replacement for core's rest_send_cors_headers() on the rest_pre_serve_request filter.
 *
 * Core's function is still what sends the headers for the site's own origin. It is also what adds "Vary: Origin" to a
 * request that has no Origin header at all, which keeps a shared cache from handing that answer to a request that
 * does, so it is called for that case as well.
 *
 * @param bool $served Whether the request has already been served; returned unchanged.
 * @return bool The unchanged $served value.
 */
function alcor_rest_cors_send_headers( $served ) {
	$origin = get_http_origin();
	if ( empty( $origin ) || alcor_rest_cors_origin_is_trusted( (string) $origin ) ) {
		return rest_send_cors_headers( $served );
	}
	if ( ! headers_sent() ) {
		header_remove( 'Access-Control-Allow-Origin' );
		header_remove( 'Access-Control-Allow-Credentials' );
		header_remove( 'Access-Control-Allow-Methods' );
		// Caches must not hand this answer to a request from the trusted origin.
		header( 'Vary: Origin', false );
	}
	return $served;
}

/**
 * Last pass: strips permissive CORS headers that anything else added for an untrusted Origin.
 *
 * It runs at the highest priority, after every other rest_pre_serve_request callback, so a plugin that sends its own
 * "Access-Control-Allow-Origin: *" cannot undo the policy above.
 *
 * @param bool $served Whether the request has already been served; returned unchanged.
 * @return bool The unchanged $served value.
 */
function alcor_rest_cors_strip_untrusted( $served ) {
	$origin = get_http_origin();
	if ( ! empty( $origin ) && ! alcor_rest_cors_origin_is_trusted( (string) $origin ) && ! headers_sent() ) {
		header_remove( 'Access-Control-Allow-Origin' );
		header_remove( 'Access-Control-Allow-Credentials' );
	}
	return $served;
}

add_filter( 'rest_pre_serve_request', 'alcor_rest_cors_send_headers', 10, 1 );
add_filter( 'rest_pre_serve_request', 'alcor_rest_cors_strip_untrusted', PHP_INT_MAX, 1 );

// Core adds rest_send_cors_headers() inside rest_api_init (priority 10, in rest_api_default_filters()), so it can only
// be removed after that. Removing it earlier, at plugin load, finds nothing to remove.
add_action(
	'rest_api_init',
	static function () {
		remove_filter( 'rest_pre_serve_request', 'rest_send_cors_headers' );
	},
	15
);
