<?php
/**
 * Alcor demo seed: creates the users, the FAQ page and the options that the checks rely on.
 *
 * The blueprint runs this once, after WordPress is installed and the mu-plugins and the fixture plugin are loaded.
 * It reads the passwords and keys that the demo script generated for this run, so no credential appears in the
 * repository, and it writes ready.json last, which is how the script knows the site is prepared.
 *
 * @package AlcorWordPress
 */

$alcor_demo_settings = alcor_demo_config();
if ( null === $alcor_demo_settings ) {
	throw new RuntimeException( 'The demo settings file is missing.' );
}

// An administrator, and a client whose role (alcor_site_editor, created by AlcorFields) is assigned one document.
$alcor_demo_admin = wp_insert_user(
	array(
		'user_login' => 'demo-admin',
		'user_pass'  => $alcor_demo_settings['admin_password'],
		'user_email' => 'demo-admin@example.com',
		'role'       => 'administrator',
	)
);
$alcor_demo_client = wp_insert_user(
	array(
		'user_login' => 'demo-client',
		'user_pass'  => $alcor_demo_settings['client_password'],
		'user_email' => 'demo-client@example.com',
		'role'       => 'alcor_site_editor',
	)
);
foreach ( array( $alcor_demo_admin, $alcor_demo_client ) as $alcor_demo_result ) {
	if ( is_wp_error( $alcor_demo_result ) ) {
		throw new RuntimeException( $alcor_demo_result->get_error_message() );
	}
}
update_user_meta( $alcor_demo_client, 'alcor_fields_documents', array( 'demo-landing' ) );

// A public page that prints the FAQ shortcode, and the IndexNow key the plugin will serve.
wp_insert_post(
	array(
		'post_type'    => 'page',
		'post_status'  => 'publish',
		'post_title'   => 'FAQ',
		'post_name'    => 'faq',
		'post_content' => '[alcor_faq]',
	)
);
update_option( 'alcor_indexnow_key', $alcor_demo_settings['indexnow_key'] );

// Rewrite rules must be rebuilt after the permalink structure changed and every plugin has registered its own.
flush_rewrite_rules( false );

file_put_contents(
	ALCOR_DEMO_STATE_DIR . '/ready.json',
	wp_json_encode(
		array(
			'wordpress'     => get_bloginfo( 'version' ),
			'php'           => PHP_VERSION,
			'home'          => home_url( '/' ),
			'environment'   => wp_get_environment_type(),
			'mu_plugins'    => array_keys( get_mu_plugins() ),
			'documents'     => array_keys( alcor_fields_documents() ),
			'client_role'   => get_userdata( $alcor_demo_client )->roles,
			'permalinks'    => get_option( 'permalink_structure' ),
		)
	)
);
