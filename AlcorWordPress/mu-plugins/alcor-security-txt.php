<?php
/**
 * Plugin Name: Alcor Security TXT
 * Description: Serves /.well-known/security.txt (RFC 9116) and redirects /security.txt to it.
 * Version: 1.0.0
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * Author: Alcor Industries
 *
 * A security.txt file tells someone who found a vulnerability where to report it. RFC 9116 requires one Contact and
 * exactly one Expires field. Set both in wp-config.php:
 *
 *     define( 'ALCOR_SECURITY_TXT_CONTACT', 'mailto:security@example.com' );
 *     define( 'ALCOR_SECURITY_TXT_EXPIRES', '2027-04-25T00:00:00Z' );
 *
 * Without them the placeholders below are served, so replace them before going live. The expiry is deliberately
 * fixed, not rolling: it is a promise that a person has looked at the contact since then, and a date that renews
 * itself would make that promise meaningless. Review it before it passes.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Returns the path part of the current request.
 *
 * This plugin keeps its own copy so it works on its own, without any other Alcor plugin.
 *
 * @return string Request path such as "/.well-known/security.txt", or "/" when there is none.
 */
function alcor_security_txt_request_path() {
	$uri = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : '/'; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- only compared with fixed strings.
	return (string) wp_parse_url( (string) $uri, PHP_URL_PATH );
}

/**
 * Builds the security.txt body from the constants, or refuses.
 *
 * Fails closed: a Contact that is not a mailto:, https: or tel: URI, or an Expires that is not an ISO 8601 UTC
 * date-time, is a configuration mistake. Publishing a wrong reporting address is worse than publishing none, so
 * the file is not served at all.
 *
 * @return string|null The file contents, or null when the configuration is invalid.
 */
function alcor_security_txt_body() {
	$contact = defined( 'ALCOR_SECURITY_TXT_CONTACT' ) ? (string) ALCOR_SECURITY_TXT_CONTACT : 'mailto:security@example.com';
	$expires = defined( 'ALCOR_SECURITY_TXT_EXPIRES' ) ? (string) ALCOR_SECURITY_TXT_EXPIRES : '2027-04-25T00:00:00Z';
	if ( ! preg_match( '#^(?:mailto:[^\s@]+@[^\s@]+|https://\S+|tel:\+?[0-9()\-.]{3,32})$#D', $contact )
		|| ! preg_match( '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/D', $expires ) ) {
		return null;
	}
	return "Contact: {$contact}\n"
		. "Expires: {$expires}\n"
		. 'Canonical: ' . home_url( '/.well-known/security.txt' ) . "\n"
		. "Preferred-Languages: en\n";
}

/**
 * Serves /.well-known/security.txt and redirects the legacy /security.txt location to it.
 *
 * Runs at priority 0 on template_redirect, before WordPress decides that the path is a 404.
 *
 * @return void
 */
function alcor_security_txt_serve() {
	$path = alcor_security_txt_request_path();
	if ( '/security.txt' === $path ) {
		wp_safe_redirect( home_url( '/.well-known/security.txt' ), 301 );
		exit;
	}
	if ( '/.well-known/security.txt' !== $path ) {
		return;
	}
	$body = alcor_security_txt_body();
	if ( null === $body ) {
		return;
	}
	status_header( 200 );
	header( 'Content-Type: text/plain; charset=utf-8' );
	header( 'X-Content-Type-Options: nosniff' );
	header( 'Cache-Control: public, max-age=3600' );
	echo $body; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- plain text built from validated constants.
	exit;
}
add_action( 'template_redirect', 'alcor_security_txt_serve', 0 );
