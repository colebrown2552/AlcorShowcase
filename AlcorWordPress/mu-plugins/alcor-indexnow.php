<?php
/**
 * Plugin Name: Alcor IndexNow
 * Description: Serves the IndexNow ownership key file so participating search engines accept URL submissions for this site.
 * Version: 1.0.0
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * Author: Alcor Industries
 *
 * IndexNow lets a site tell Bing and the other participating engines which URLs changed, so new and changed pages are
 * crawled in hours instead of weeks. To prove that the site owns the URLs it submits, it publishes its key as a text
 * file at /<key>.txt on its own host. The key is not a secret (the protocol requires it to be publicly readable), but
 * it is configuration, so it is read from the ALCOR_INDEXNOW_KEY constant in wp-config.php or, failing that, from the
 * alcor_indexnow_key option, and is never committed:
 *
 *     define( 'ALCOR_INDEXNOW_KEY', 'a-key-of-8-to-128-letters-digits-and-dashes' );
 *
 * Without a valid key the plugin does nothing. It also stays silent on preview hosts (see
 * alcor-preview-noindex.php), so a staging copy cannot claim ownership of production URLs. Sending the URLs is a job
 * for a deploy script, not for this plugin: POST {host, key, keyLocation, urlList} to the IndexNow endpoint.
 * Reversible: delete this file.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Returns the configured IndexNow key.
 *
 * @return string The key, or '' when none is configured or it is not 8 to 128 letters, digits and dashes.
 */
function alcor_indexnow_key() {
	$key = defined( 'ALCOR_INDEXNOW_KEY' ) ? ALCOR_INDEXNOW_KEY : get_option( 'alcor_indexnow_key', '' );
	return is_string( $key ) && preg_match( '/^[A-Za-z0-9-]{8,128}$/D', $key ) ? $key : '';
}

/**
 * Answers a request for /<key>.txt with the key, and ends the request.
 *
 * Runs on parse_request at priority 0, before WordPress looks for a page of that name.
 *
 * @return void
 */
function alcor_indexnow_serve_key() {
	$key = alcor_indexnow_key();
	if ( '' === $key ) {
		return;
	}
	$uri  = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- only compared with a fixed string.
	$path = (string) wp_parse_url( (string) $uri, PHP_URL_PATH );
	if ( '/' . $key . '.txt' !== $path ) {
		return;
	}
	if ( function_exists( 'alcor_is_preview_host' ) && alcor_is_preview_host() ) {
		return;
	}
	status_header( 200 );
	header( 'Content-Type: text/plain; charset=utf-8' );
	header( 'X-Robots-Tag: noindex' );
	echo $key; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- validated above to letters, digits and dashes.
	exit;
}
add_action( 'parse_request', 'alcor_indexnow_serve_key', 0 );
