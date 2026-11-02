<?php
/**
 * Plugin Name: Alcor Preview Noindex
 * Description: Keeps preview, staging and local hosts out of search indexes.
 * Version: 1.0.0
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * Author: Alcor Industries
 *
 * A copy of the site on a preview host must never compete with the real one in search results. A host counts as a
 * preview when it is a loopback address, a *.localhost name, or starts with one of ALCOR_PREVIEW_HOST_PREFIXES
 * ("staging.example.com"). On such a host every response carries an X-Robots-Tag header and every page a robots meta
 * tag, and canonical links point at the production host. Other plugins ask alcor_is_preview_host() whether to stay
 * quiet (alcor-indexnow.php does).
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Host name prefixes that mark a preview copy of a site. The rest of the host is the production host.
 */
const ALCOR_PREVIEW_HOST_PREFIXES = array( 'deploy.', 'staging.' );

/**
 * Returns the request's host name, lower case and without a port.
 *
 * @return string The host, or '' when the request has none.
 */
function alcor_preview_request_host() {
	$host = isset( $_SERVER['HTTP_HOST'] ) ? strtolower( sanitize_text_field( wp_unslash( $_SERVER['HTTP_HOST'] ) ) ) : '';
	return (string) preg_replace( '/:\d+$/', '', $host );
}

/**
 * Strips a preview prefix from a host name.
 *
 * @param string $host Lower-case host name.
 * @return string The production host, or '' when $host has no preview prefix.
 */
function alcor_preview_production_host( $host ) {
	foreach ( ALCOR_PREVIEW_HOST_PREFIXES as $prefix ) {
		if ( str_starts_with( $host, $prefix ) && strlen( $host ) > strlen( $prefix ) ) {
			return substr( $host, strlen( $prefix ) );
		}
	}
	return '';
}

/**
 * Tells whether the current request is for a preview copy of the site.
 *
 * Staging copies and loopback hosts (local review builds) are not the production site: they stay out of search.
 *
 * @return bool True on a loopback, *.localhost or preview-prefixed host.
 */
function alcor_is_preview_host() {
	$host = alcor_preview_request_host();
	if ( 'localhost' === $host || str_ends_with( $host, '.localhost' ) || '[::1]' === $host
		|| preg_match( '/^127(?:\.\d{1,3}){3}$/', $host ) ) {
		return true;
	}
	return '' !== alcor_preview_production_host( $host );
}

/**
 * Sends the noindex header on a preview host. The header also covers files that have no HTML head to carry a meta tag.
 *
 * @return void
 */
function alcor_preview_send_noindex_header() {
	if ( alcor_is_preview_host() ) {
		header( 'X-Robots-Tag: noindex, nofollow, noarchive', true );
	}
}
add_action( 'send_headers', 'alcor_preview_send_noindex_header' );

/**
 * Adds noindex to the robots meta tag that core prints (wp_robots), on a preview host only.
 *
 * Going through core's wp_robots filter keeps one robots tag on the page instead of two that could disagree.
 *
 * @param array<string, bool|string> $robots Directives core is about to print.
 * @return array<string, bool|string> The directives, with noindex added on a preview host.
 */
function alcor_preview_robots( $robots ) {
	if ( alcor_is_preview_host() ) {
		$robots['noindex']   = true;
		$robots['nofollow']  = true;
		$robots['noarchive'] = true;
	}
	return $robots;
}
add_filter( 'wp_robots', 'alcor_preview_robots' );

/**
 * Keeps canonical links on the equivalent production URL, without changing navigation.
 *
 * On "staging.example.com" a page's canonical link becomes "https://example.com/same/path/". Search engines that
 * ignore the noindex header then still credit the production page.
 *
 * @param mixed $url The canonical URL, as built for the current host.
 * @return mixed The production URL on a preview host; otherwise $url unchanged.
 */
function alcor_preview_canonical_url( $url ) {
	if ( ! is_string( $url ) ) {
		return $url;
	}
	$parts      = wp_parse_url( $url );
	$home_host  = strtolower( (string) wp_parse_url( home_url( '/' ), PHP_URL_HOST ) );
	$production = alcor_preview_production_host( $home_host );
	if ( ! is_array( $parts ) || strtolower( $parts['host'] ?? '' ) !== $home_host || '' === $production ) {
		return $url;
	}
	return 'https://' . $production . ( $parts['path'] ?? '/' ) . ( isset( $parts['query'] ) ? '?' . $parts['query'] : '' );
}
// Core's canonical link, and the filter that a theme with its own canonical tag can apply.
add_filter( 'get_canonical_url', 'alcor_preview_canonical_url' );
add_filter( 'alcor_canonical_url', 'alcor_preview_canonical_url' );
