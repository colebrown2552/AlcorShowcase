<?php
/**
 * Plugin Name: Alcor No User Enumeration
 * Description: Keeps account names off the public site: author archives and ?author= redirect to the homepage, anonymous REST user lookups are refused, and feeds and oEmbed carry no author link or account name.
 * Version: 1.0.0
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * Author: Alcor Industries
 *
 * A WordPress login name is half of a credential. Core hands it out in four places: /?author=<id> redirects to
 * /author/<login>/, the REST route /wp/v2/users lists every author, oEmbed responses carry the author's name and
 * archive link, and feeds print the display name. This plugin closes all four for visitors. It assumes the site has
 * no author pages (a site that wants them should not install it). The users sitemap is removed in
 * alcor-public-sitemap.php.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// /?author=1, /?author_name=x and /author/<name>/ go to the homepage. Priority 0 runs before core's
// redirect_canonical() (priority 10), which would otherwise answer /?author=1 with a redirect to /author/<login>/ and
// so reveal the login name.
add_action(
	'template_redirect',
	static function () {
		if ( is_admin() ) {
			return;
		}
		if ( is_author() || get_query_var( 'author' ) || get_query_var( 'author_name' )
			|| isset( $_GET['author'] ) || isset( $_GET['author_name'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only routing check, nothing is stored.
			wp_safe_redirect( home_url( '/' ), 301 );
			exit;
		}
	},
	0
);

// Nothing on the front end links to an author archive.
add_filter(
	'author_link',
	static function ( $link ) {
		return is_admin() ? $link : home_url( '/' );
	},
	99
);

// REST users (/wp/v2/users and /wp/v2/users/<id>) are for signed-in editors only. The block editor still works,
// because its requests carry a login. rest_pre_dispatch also covers requests that core makes internally to embed an
// author into a post (?_embed), so those are refused too.
add_filter(
	'rest_pre_dispatch',
	static function ( $result, $server, $request ) {
		if ( null !== $result || is_user_logged_in() ) {
			return $result;
		}
		if ( preg_match( '#^/wp/v2/users(?:/|$)#', (string) $request->get_route() ) ) {
			return new WP_Error( 'rest_forbidden', 'Not available.', array( 'status' => 403 ) );
		}
		return $result;
	},
	10,
	3
);

// oEmbed responses name the site, not the account.
add_filter(
	'oembed_response_data',
	static function ( $data ) {
		unset( $data['author_url'] );
		$data['author_name'] = get_bloginfo( 'name' );
		return $data;
	},
	99
);

/*
 * Feeds show the site name, not an account name. A site that wants a real byline in one of its feeds (an editorial
 * blog feed, say) returns true from this filter while that feed is being built:
 *
 *     add_filter( 'alcor_feed_shows_byline', static function () { return is_feed( 'my-blog' ); } );
 */
add_filter(
	'the_author',
	static function ( $author ) {
		if ( is_feed() && ! apply_filters( 'alcor_feed_shows_byline', false ) ) {
			return get_bloginfo( 'name' );
		}
		return $author;
	},
	20
);
